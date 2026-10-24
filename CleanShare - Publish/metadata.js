// metadata.js
// The heart of CleanShare: finding and removing hidden information
// ("metadata") in JPEG and PNG photos.
//
// A photo file is made of labelled blocks. Some blocks hold the picture,
// others hold hidden info (GPS, camera model, dates...). To clean a photo we
// copy the picture blocks byte for byte and simply leave the info blocks out.
// The picture is never decoded or re-saved, so its quality stays identical.
//
// The two functions the page uses are at the bottom:
//   readMetadata(bytes)   -> a report listing the hidden info found
//   removeMetadata(bytes) -> a new, clean copy of the file

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Reads `length` bytes as plain ASCII text (used for block names and labels).
function ascii(bytes, start, length) {
  let text = '';
  for (let i = start; i < start + length && i < bytes.length; i++) {
    text += String.fromCharCode(bytes[i]);
  }
  return text;
}

function startsWith(bytes, text) {
  return ascii(bytes, 0, text.length) === text;
}

function decodeText(bytes, encoding) {
  return new TextDecoder(encoding || 'utf-8').decode(bytes);
}

// Removes invisible control characters and extra spaces.
function cleanText(text) {
  return String(text)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Reads a 4-byte number stored "big-endian" (most significant byte first).
function readUint32(bytes, pos) {
  return ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
}

// Glues several byte arrays together into one.
function joinBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    result.set(part, pos);
    pos += part.length;
  }
  return result;
}

function formatSize(byteCount) {
  if (byteCount < 1024) return byteCount + ' bytes';
  if (byteCount < 1024 * 1024) return (byteCount / 1024).toFixed(1) + ' KB';
  return (byteCount / (1024 * 1024)).toFixed(1) + ' MB';
}

// Turns "2024:05:12 14:33:09" or "2024-05-12T14:33:09" into "12 May 2024 at 14:33".
function formatDate(text) {
  const match = String(text).match(/^(\d{4})[:-](\d{2})[:-](\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!match || match[1] === '0000') return cleanText(text);
  const [, year, month, day, hour, minute] = match;
  const date = new Date(+year, +month - 1, +day, +(hour || 0), +(minute || 0));
  if (isNaN(date)) return cleanText(text);
  const options = hour ? { dateStyle: 'long', timeStyle: 'short' } : { dateStyle: 'long' };
  return date.toLocaleString(undefined, options);
}

function formatCoordinates(lat, lon) {
  return Math.abs(lat).toFixed(5) + '° ' + (lat >= 0 ? 'N' : 'S') + ', ' +
         Math.abs(lon).toFixed(5) + '° ' + (lon >= 0 ? 'E' : 'W');
}

// ---------------------------------------------------------------------------
// The report: a list of findings, each with a category, a label and a value
// ---------------------------------------------------------------------------

function createReport(type) {
  return {
    type: type,          // 'jpeg' or 'png'
    items: [],           // { category, label, value }
    location: null,      // { lat, lon } when GPS was found
    orientation: 1,      // rotation tag (1 = normal); kept in the clean copy
    otherBlocks: 0       // count of unrecognised info blocks
  };
}

// Adds one finding. Empty values and repeated labels are ignored, so the
// same info found in two places (e.g. EXIF and XMP) is only listed once.
function addItem(report, category, label, value) {
  if (value === undefined || value === null) return;
  let text = cleanText(value);
  if (!text) return;
  if (text.length > 200) text = text.slice(0, 200) + '…';
  if (report.items.some((item) => item.label === label)) return;
  report.items.push({ category: category, label: label, value: text });
}

function setLocation(report, lat, lon) {
  if (report.location || !isFinite(lat) || !isFinite(lon)) return;
  report.location = { lat: lat, lon: lon };
  addItem(report, 'location', 'GPS coordinates', formatCoordinates(lat, lon));
}

// Runs a reader, but if a block is damaged we note it instead of crashing.
function safely(report, reader) {
  try {
    reader();
  } catch (error) {
    report.otherBlocks++;
  }
}

// ---------------------------------------------------------------------------
// EXIF: the main hidden-info block written by phones and cameras
// ---------------------------------------------------------------------------

// How many bytes each EXIF value type uses.
const EXIF_TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function readExif(tiff, report) {
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const byteOrder = ascii(tiff, 0, 2);
  if (byteOrder !== 'II' && byteOrder !== 'MM') return;
  const little = byteOrder === 'II';
  const u16 = (pos) => view.getUint16(pos, little);
  const u32 = (pos) => view.getUint32(pos, little);

  function readValue(type, pos, count) {
    if (type === 2) return decodeText(tiff.subarray(pos, pos + count), 'latin1').replace(/\0.*$/, '');
    if (type === 1 || type === 7) return tiff.subarray(pos, pos + count);
    const values = [];
    for (let i = 0; i < Math.min(count, 16); i++) {
      if (type === 3) values.push(u16(pos + i * 2));
      if (type === 4) values.push(u32(pos + i * 4));
      if (type === 9) values.push(view.getInt32(pos + i * 4, little));
      if (type === 5 || type === 10) {
        const top = type === 5 ? u32(pos + i * 8) : view.getInt32(pos + i * 8, little);
        const bottom = type === 5 ? u32(pos + i * 8 + 4) : view.getInt32(pos + i * 8 + 4, little);
        values.push(bottom ? top / bottom : 0);
      }
    }
    return count === 1 ? values[0] : values;
  }

  // An "IFD" is a list of tags. Returns { tags: {tagNumber: value}, next }.
  function readIfd(offset) {
    const tags = {};
    if (typeof offset !== 'number' || offset < 8 || offset + 2 > tiff.length) return { tags: tags, next: 0 };
    const count = u16(offset);
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12;
      if (entry + 12 > tiff.length) break;
      const tag = u16(entry);
      const type = u16(entry + 2);
      const valueCount = u32(entry + 4);
      const size = EXIF_TYPE_SIZES[type];
      if (!size) continue;
      const totalSize = size * valueCount;
      const valuePos = totalSize <= 4 ? entry + 8 : u32(entry + 8);
      if (valuePos + totalSize > tiff.length) continue;
      tags[tag] = readValue(type, valuePos, valueCount);
    }
    const nextPos = offset + 2 + count * 12;
    return { tags: tags, next: nextPos + 4 <= tiff.length ? u32(nextPos) : 0 };
  }

  const main = readIfd(u32(4));
  const tags = Object.assign({}, main.tags, readIfd(main.tags[0x8769]).tags);
  const gps = readIfd(main.tags[0x8825]).tags;

  if (typeof tags[0x0112] === 'number') report.orientation = tags[0x0112];

  // Location
  const lat = gpsToDecimal(gps[2], gps[1]);
  const lon = gpsToDecimal(gps[4], gps[3]);
  if (lat !== null && lon !== null) setLocation(report, lat, lon);
  if (typeof gps[6] === 'number') {
    const below = gps[5] && gps[5][0] === 1;
    addItem(report, 'location', 'Altitude', Math.round(gps[6]) + ' m ' + (below ? 'below' : 'above') + ' sea level');
  }
  if (typeof gps[17] === 'number') {
    addItem(report, 'location', 'Direction camera was facing', Math.round(gps[17]) + '°');
  }

  // Device
  addItem(report, 'device', 'Phone or camera', joinMakeModel(tags[0x010F], tags[0x0110]));
  addItem(report, 'device', 'Lens', joinMakeModel(tags[0xA433], tags[0xA434]));
  addItem(report, 'device', 'Camera serial number', tags[0xA431]);
  addItem(report, 'device', 'Lens serial number', tags[0xA435]);
  addItem(report, 'device', 'Software used', tags[0x0131]);

  // Date and time
  const taken = tags[0x9003] || tags[0x9004];
  if (taken) {
    const timeZone = tags[0x9011] || tags[0x9012];
    addItem(report, 'time', 'Taken on', formatDate(taken) + (timeZone ? ' (UTC' + timeZone + ')' : ''));
  }
  if (tags[0x0132]) addItem(report, 'time', 'Last changed on', formatDate(tags[0x0132]));

  // People and copyright
  addItem(report, 'people', 'Camera owner', tags[0xA430]);
  addItem(report, 'people', 'Author', tags[0x013B]);
  addItem(report, 'people', 'Copyright', tags[0x8298]);

  // Other
  addItem(report, 'other', 'Description', tags[0x010E]);
  addItem(report, 'other', 'Comment', readUserComment(tags[0x9286], little));
  addItem(report, 'other', 'Unique photo ID', tags[0xA420]);
  if (readIfd(main.next).tags[0x0201] !== undefined) {
    addItem(report, 'other', 'Preview thumbnail', 'A small copy of the photo is stored inside. It can show the original photo from before it was cropped or edited.');
  }
}

// GPS is stored as [degrees, minutes, seconds] plus a letter N/S/E/W.
function gpsToDecimal(parts, ref) {
  if (!Array.isArray(parts) || parts.length < 3) return null;
  const value = parts[0] + parts[1] / 60 + parts[2] / 3600;
  return ref === 'S' || ref === 'W' ? -value : value;
}

// "Apple" + "iPhone 15 Pro" -> "Apple iPhone 15 Pro", but
// "Canon" + "Canon EOS R5" -> "Canon EOS R5" (no repeat).
function joinMakeModel(make, model) {
  make = cleanText(make || '');
  model = cleanText(model || '');
  if (model.toLowerCase().startsWith(make.toLowerCase())) return model;
  return (make + ' ' + model).trim();
}

// The EXIF "user comment" starts with 8 bytes naming its text encoding.
function readUserComment(bytes, little) {
  if (!(bytes instanceof Uint8Array) || bytes.length <= 8) return '';
  const encoding = ascii(bytes, 0, 8);
  const text = bytes.subarray(8);
  if (encoding.startsWith('UNICODE')) return decodeText(text, little ? 'utf-16le' : 'utf-16be').replace(/\0/g, '');
  return decodeText(text, 'latin1').replace(/\0/g, '');
}

// A tiny EXIF block holding ONLY the rotation tag. Written into the clean
// copy so photos taken sideways still appear the right way up.
function makeOrientationExif(orientation) {
  return new Uint8Array([
    0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08, // header: big-endian, list starts at byte 8
    0x00, 0x01,                                     // 1 tag in the list
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, // tag 0x0112 (Orientation), 1 number
    0x00, orientation, 0x00, 0x00,                  // the rotation value
    0x00, 0x00, 0x00, 0x00                          // no more lists
  ]);
}

function hasRotation(orientation) {
  return orientation >= 2 && orientation <= 8;
}

// ---------------------------------------------------------------------------
// XMP: hidden info stored as text, often added by editing apps
// ---------------------------------------------------------------------------

function readXmp(xml, report) {
  const countBefore = report.items.length;

  // Finds a value written either as name="value" or as <name>value</name>.
  function get(name) {
    let match = xml.match(new RegExp('\\s' + name + '="([^"]*)"'));
    if (match) return decodeXmlEntities(match[1]);
    match = xml.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>'));
    if (match) return decodeXmlEntities(match[1].replace(/<[^>]+>/g, ' '));
    return '';
  }

  const lat = xmpCoordinate(get('exif:GPSLatitude'));
  const lon = xmpCoordinate(get('exif:GPSLongitude'));
  if (lat !== null && lon !== null) setLocation(report, lat, lon);
  const place = [get('Iptc4xmpCore:Location'), get('photoshop:City'), get('photoshop:State'), get('photoshop:Country')];
  addItem(report, 'location', 'Place name', place.filter(Boolean).join(', '));

  addItem(report, 'device', 'Phone or camera', joinMakeModel(get('tiff:Make'), get('tiff:Model')));
  addItem(report, 'device', 'Lens', get('aux:Lens') || get('exifEX:LensModel'));
  addItem(report, 'device', 'Camera serial number', get('aux:SerialNumber') || get('exifEX:BodySerialNumber'));
  addItem(report, 'device', 'Software used', get('xmp:CreatorTool'));

  const taken = get('exif:DateTimeOriginal') || get('photoshop:DateCreated') || get('xmp:CreateDate');
  if (taken) addItem(report, 'time', 'Taken on', formatDate(taken));
  const changed = get('xmp:ModifyDate');
  if (changed) addItem(report, 'time', 'Last changed on', formatDate(changed));

  addItem(report, 'people', 'Author', get('dc:creator'));
  addItem(report, 'people', 'Copyright', get('dc:rights'));

  addItem(report, 'other', 'Title', get('dc:title'));
  addItem(report, 'other', 'Description', get('dc:description'));
  addItem(report, 'other', 'Keywords', get('dc:subject'));
  addItem(report, 'other', 'Comment', get('exif:UserComment'));
  if (/xmpMM:History|photoshop:History/.test(xml)) {
    addItem(report, 'other', 'Editing history', 'A record of how and when the photo was edited.');
  }

  if (report.items.length === countBefore) {
    addItem(report, 'other', 'App data (XMP)', 'Extra details written by a camera or editing app.');
  }
}

// XMP writes GPS like "48,51.504N" or "48,51,30.2N".
function xmpCoordinate(text) {
  const match = text.match(/^(\d+),(\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?))?([NSEW])$/);
  if (!match) return null;
  const value = +match[1] + match[2] / 60 + (match[3] ? match[3] / 3600 : 0);
  return match[4] === 'S' || match[4] === 'W' ? -value : value;
}

function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (all, code) => String.fromCharCode(code))
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------
// IPTC: hidden info used by Photoshop and news agencies (author, captions...)
// ---------------------------------------------------------------------------

function readPhotoshop(data, report) {
  addItem(report, 'other', 'Photoshop / IPTC data', 'Extra details saved by photo editing or news software.');
  if (!startsWith(data, 'Photoshop 3.0\0')) return;
  let pos = 14;
  while (pos + 12 <= data.length && ascii(data, pos, 4) === '8BIM') {
    const id = (data[pos + 4] << 8) | data[pos + 5];
    const nameLength = data[pos + 6];
    const sizePos = pos + 6 + ((nameLength + 2) & ~1); // name is padded to an even length
    const size = readUint32(data, sizePos);
    const content = data.subarray(sizePos + 4, sizePos + 4 + size);
    if (id === 0x0404) readIptc(content, report);
    pos = sizePos + 4 + size + (size % 2);
  }
}

function readIptc(data, report) {
  const fields = {};
  let pos = 0;
  while (pos + 5 <= data.length && data[pos] === 0x1C) {
    const record = data[pos + 1];
    const field = data[pos + 2];
    const length = (data[pos + 3] << 8) | data[pos + 4];
    if (length & 0x8000) break; // very large field: not used for text
    if (record === 2) {
      const value = decodeText(data.subarray(pos + 5, pos + 5 + length));
      fields[field] = fields[field] ? fields[field] + ', ' + value : value;
    }
    pos += 5 + length;
  }
  addItem(report, 'location', 'Place name', [fields[92], fields[90], fields[95], fields[101]].filter(Boolean).join(', '));
  if (fields[55]) addItem(report, 'time', 'Taken on', formatDate(fields[55].replace(/^(\d{4})(\d{2})(\d{2})$/, '$1:$2:$3')));
  addItem(report, 'people', 'Author', fields[80]);
  addItem(report, 'people', 'Copyright', fields[116]);
  addItem(report, 'other', 'Title', fields[5]);
  addItem(report, 'other', 'Description', fields[120]);
  addItem(report, 'other', 'Keywords', fields[25]);
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

// Splits a JPEG into its blocks ("segments"). Each starts with the byte 0xFF
// followed by a "marker" byte saying what kind of block it is.
function splitJpeg(bytes) {
  const segments = [];
  let pos = 2; // skip the 2-byte "start of image" marker
  while (pos + 1 < bytes.length) {
    if (bytes[pos] !== 0xFF) throw new Error('This JPEG file seems to be damaged.');
    while (bytes[pos + 1] === 0xFF) pos++; // skip padding bytes
    const marker = bytes[pos + 1];

    // Markers that are just 2 bytes with no content.
    if (marker === 0xD9) { // end of image
      segments.push({ marker: marker, start: pos, end: pos + 2 });
      return { segments: segments, trailingBytes: bytes.length - (pos + 2) };
    }
    if ((marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) {
      segments.push({ marker: marker, start: pos, end: pos + 2 });
      pos += 2;
      continue;
    }

    const length = (bytes[pos + 2] << 8) | bytes[pos + 3];
    let end = pos + 2 + length;
    if (length < 2 || end > bytes.length) throw new Error('This JPEG file seems to be damaged.');

    // "Start of scan": the compressed picture follows. It ends at the first
    // 0xFF that is followed by a real marker (0x00 and 0xD0-0xD7 don't count).
    if (marker === 0xDA) {
      while (end < bytes.length) {
        if (bytes[end] === 0xFF) {
          const next = bytes[end + 1];
          if (next === 0x00 || (next >= 0xD0 && next <= 0xD7)) { end += 2; continue; }
          if (next !== 0xFF) break;
        }
        end++;
      }
      end = Math.min(end, bytes.length);
    }

    segments.push({ marker: marker, start: pos, end: end });
    pos = end;
  }
  // The file was cut off before its end marker; work with what we have.
  return { segments: segments, trailingBytes: 0 };
}

// Decides what a JPEG block is: picture data we keep, or hidden info we remove.
function jpegSegmentKind(marker, content) {
  if (marker === 0xE1 && startsWith(content, 'Exif\0')) return 'exif';
  if (marker === 0xE1 && startsWith(content, 'http://ns.adobe.com/xap/1.0/\0')) return 'xmp';
  if (marker === 0xED) return 'photoshop';
  if (marker === 0xFE) return 'comment';
  if (marker === 0xE0 && startsWith(content, 'JFIF\0')) return 'keep';        // basic format info
  if (marker === 0xE2 && startsWith(content, 'ICC_PROFILE\0')) return 'keep'; // colour profile
  if (marker === 0xEE && startsWith(content, 'Adobe')) return 'keep';         // colour format
  if (marker >= 0xE0 && marker <= 0xEF) return 'other';                        // other app data
  return 'keep'; // the picture itself and the tables needed to decode it
}

function segmentContent(bytes, segment) {
  return bytes.subarray(Math.min(segment.start + 4, segment.end), segment.end);
}

function readJpegMetadata(bytes, report) {
  const { segments, trailingBytes } = splitJpeg(bytes);
  for (const segment of segments) {
    const content = segmentContent(bytes, segment);
    const kind = jpegSegmentKind(segment.marker, content);
    if (kind === 'exif') safely(report, () => readExif(content.subarray(6), report));
    if (kind === 'xmp') safely(report, () => readXmp(decodeText(content.subarray(29)), report));
    if (kind === 'photoshop') safely(report, () => readPhotoshop(content, report));
    if (kind === 'comment') addItem(report, 'other', 'Comment', decodeText(content, 'latin1'));
    if (kind === 'other') report.otherBlocks++;
  }
  if (trailingBytes > 0) {
    addItem(report, 'other', 'Extra hidden data', formatSize(trailingBytes) + ' attached after the photo (often extra images used by phones, such as depth or HDR data).');
  }
}

function removeJpegMetadata(bytes, orientation) {
  const { segments } = splitJpeg(bytes);
  const parts = [bytes.subarray(0, 2)]; // "start of image" marker
  let rotationAdded = !hasRotation(orientation);

  for (const segment of segments) {
    const kind = jpegSegmentKind(segment.marker, segmentContent(bytes, segment));
    if (kind !== 'keep') continue;
    // Put the rotation-only EXIF block right after the JFIF block (or first).
    if (!rotationAdded && segment.marker !== 0xE0) {
      const exif = joinBytes([new TextEncoder().encode('Exif\0\0'), makeOrientationExif(orientation)]);
      const length = exif.length + 2;
      parts.push(new Uint8Array([0xFF, 0xE1, length >> 8, length & 0xFF]), exif);
      rotationAdded = true;
    }
    parts.push(bytes.subarray(segment.start, segment.end));
  }
  return joinBytes(parts);
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

// PNG blocks ("chunks") that hold the picture or affect how it looks.
// Everything else (text notes, EXIF, timestamps...) is removed.
const PNG_KEEP = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND',                         // the picture
  'tRNS', 'bKGD', 'pHYs', 'sBIT', 'hIST', 'sPLT',         // transparency, size, palette
  'gAMA', 'cHRM', 'sRGB', 'iCCP', 'cICP', 'mDCV', 'cLLI', // colour
  'acTL', 'fcTL', 'fdAT'                                  // animation
]);

function isKeptPngChunk(type) {
  // A capital first letter means "required to show the image", so keep those too.
  const isCritical = type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90;
  return PNG_KEEP.has(type) || isCritical;
}

// Each chunk is: length (4 bytes), type (4 letters), content, checksum (4 bytes).
function splitPng(bytes) {
  const chunks = [];
  let pos = 8; // skip the 8-byte PNG signature
  while (pos + 12 <= bytes.length) {
    const length = readUint32(bytes, pos);
    const type = ascii(bytes, pos + 4, 4);
    const end = pos + 12 + length;
    if (end > bytes.length) throw new Error('This PNG file seems to be damaged.');
    chunks.push({ type: type, start: pos, end: end, content: bytes.subarray(pos + 8, pos + 8 + length) });
    pos = end;
    if (type === 'IEND') break;
  }
  return { chunks: chunks, trailingBytes: bytes.length - pos };
}

function readPngMetadata(bytes, report) {
  const { chunks, trailingBytes } = splitPng(bytes);
  for (const chunk of chunks) {
    const content = chunk.content;
    if (chunk.type === 'tEXt') {
      const split = content.indexOf(0);
      if (split > 0) addPngText(report, ascii(content, 0, split), decodeText(content.subarray(split + 1), 'latin1'));
    } else if (chunk.type === 'zTXt') {
      const split = content.indexOf(0);
      if (split > 0) addPngText(report, ascii(content, 0, split), 'Compressed text note.');
    } else if (chunk.type === 'iTXt') {
      safely(report, () => readPngInternationalText(content, report));
    } else if (chunk.type === 'eXIf') {
      safely(report, () => readExif(content, report));
    } else if (chunk.type === 'tIME' && content.length >= 7) {
      const year = (content[0] << 8) | content[1];
      const date = new Date(Date.UTC(year, content[2] - 1, content[3], content[4], content[5]));
      addItem(report, 'time', 'Last changed on', date.toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' }));
    } else if (!isKeptPngChunk(chunk.type)) {
      report.otherBlocks++;
    }
  }
  if (trailingBytes > 0) {
    addItem(report, 'other', 'Extra hidden data', formatSize(trailingBytes) + ' attached after the image.');
  }
}

// iTXt chunk: keyword, flags, language, translated keyword, then the text.
function readPngInternationalText(content, report) {
  let pos = content.indexOf(0);
  const keyword = ascii(content, 0, pos);
  const compressed = content[pos + 1] === 1;
  pos = content.indexOf(0, pos + 3);     // skip language
  pos = content.indexOf(0, pos + 1) + 1; // skip translated keyword
  if (compressed) {
    addPngText(report, keyword, 'Compressed text note.');
    return;
  }
  const text = decodeText(content.subarray(pos));
  if (keyword === 'XML:com.adobe.xmp') readXmp(text, report);
  else addPngText(report, keyword, text);
}

// PNG text notes have a keyword ("Author", "Software"...) and a value.
function addPngText(report, keyword, text) {
  if (keyword === 'Author') addItem(report, 'people', 'Author', text);
  else if (keyword === 'Copyright') addItem(report, 'people', 'Copyright', text);
  else if (keyword === 'Creation Time') addItem(report, 'time', 'Created on', formatDate(text));
  else if (keyword === 'Software') addItem(report, 'device', 'Software used', text);
  else if (keyword === 'Source') addItem(report, 'device', 'Phone or camera', text);
  else if (keyword.startsWith('Raw profile type')) addItem(report, 'other', 'Hidden technical data', 'A copy of camera or app info stored as code.');
  else addItem(report, 'other', keyword, text);
}

// PNG chunks end with a checksum (CRC-32) so programs can detect damage.
let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makePngChunk(type, content) {
  const typeAndContent = joinBytes([new TextEncoder().encode(type), content]);
  const result = new Uint8Array(12 + content.length);
  const view = new DataView(result.buffer);
  view.setUint32(0, content.length);
  result.set(typeAndContent, 4);
  view.setUint32(8 + content.length, crc32(typeAndContent));
  return result;
}

function removePngMetadata(bytes, orientation) {
  const { chunks } = splitPng(bytes);
  const parts = [bytes.subarray(0, 8)]; // PNG signature
  for (const chunk of chunks) {
    if (!isKeptPngChunk(chunk.type)) continue;
    parts.push(bytes.subarray(chunk.start, chunk.end));
    if (chunk.type === 'IHDR' && hasRotation(orientation)) {
      parts.push(makePngChunk('eXIf', makeOrientationExif(orientation)));
    }
  }
  return joinBytes(parts);
}

// ---------------------------------------------------------------------------
// The functions used by the page
// ---------------------------------------------------------------------------

// Returns 'jpeg', 'png', 'heic' (iPhone format, not supported yet) or 'unknown'.
function detectFileType(bytes) {
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'jpeg';
  if (ascii(bytes, 0, 8) === '\x89PNG\r\n\x1A\n') return 'png';
  if (ascii(bytes, 4, 4) === 'ftyp' && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(ascii(bytes, 8, 4))) return 'heic';
  return 'unknown';
}

// Lists the hidden info in a JPEG or PNG file (given as a Uint8Array).
function readMetadata(bytes) {
  const type = detectFileType(bytes);
  const report = createReport(type);
  if (type === 'jpeg') readJpegMetadata(bytes, report);
  else if (type === 'png') readPngMetadata(bytes, report);
  else throw new Error('Only JPEG and PNG photos are supported.');

  if (report.otherBlocks > 0) {
    addItem(report, 'other', 'Other technical data', report.otherBlocks + ' extra data block' + (report.otherBlocks > 1 ? 's' : '') + ' added by a camera or app.');
  }
  return report;
}

// Returns a clean copy of the file with all hidden info removed.
// Only the rotation tag is kept, so the photo still shows the right way up.
function removeMetadata(bytes) {
  const report = readMetadata(bytes);
  if (report.type === 'jpeg') return removeJpegMetadata(bytes, report.orientation);
  return removePngMetadata(bytes, report.orientation);
}
