// tests/run-tests.js
// Checks that CleanShare finds hidden info and removes it without touching
// the picture. Run it with:  node tests/run-tests.js
//
// It builds test photos stuffed with fake GPS, camera and author info,
// cleans them with metadata.js, and verifies the results.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const os = require('os');
const { execFileSync } = require('child_process');

// Load metadata.js the same way the browser does (as a plain script).
const app = { TextDecoder, TextEncoder };
vm.createContext(app);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'metadata.js'), 'utf8'), app);

let failures = 0;
function check(description, condition) {
  console.log((condition ? '  ✓ ' : '  ✗ ') + description);
  if (!condition) failures++;
}

function sameBytes(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

// ---------------------------------------------------------------------------
// Builders for fake metadata
// ---------------------------------------------------------------------------

// Builds an EXIF (TIFF) block. `ifds` is a list of tag lists; a value of
// { pointer: n } is replaced by the position of list number n.
function buildTiff(ifds, nextOfFirst) {
  const view = new DataView(new ArrayBuffer(4096));
  const bytes = new Uint8Array(view.buffer);
  bytes.set([0x4D, 0x4D, 0x00, 0x2A, 0, 0, 0, 8]);
  const offsets = [];
  let pos = 8;
  for (const ifd of ifds) { offsets.push(pos); pos += 2 + ifd.length * 12 + 4; }
  let dataPos = pos;

  ifds.forEach((ifd, index) => {
    let p = offsets[index];
    view.setUint16(p, ifd.length); p += 2;
    for (const [tag, type, value] of ifd) {
      let raw, count;
      if (type === 2) { raw = Buffer.from(value + '\0', 'latin1'); count = raw.length; }
      else if (type === 1 || type === 7) { raw = Buffer.from(value); count = raw.length; }
      else if (type === 3) { raw = Buffer.alloc(value.length * 2); value.forEach((v, i) => raw.writeUInt16BE(v, i * 2)); count = value.length; }
      else if (type === 4) { const v = value.pointer !== undefined ? offsets[value.pointer] : value; raw = Buffer.alloc(4); raw.writeUInt32BE(v); count = 1; }
      else if (type === 5) { raw = Buffer.alloc(value.length * 8); value.forEach(([a, b], i) => { raw.writeUInt32BE(a, i * 8); raw.writeUInt32BE(b, i * 8 + 4); }); count = value.length; }
      view.setUint16(p, tag); view.setUint16(p + 2, type); view.setUint32(p + 4, count);
      if (raw.length <= 4) bytes.set(raw, p + 8);
      else { view.setUint32(p + 8, dataPos); bytes.set(raw, dataPos); dataPos += raw.length + (raw.length % 2); }
      p += 12;
    }
    view.setUint32(p, index === 0 && nextOfFirst !== undefined ? offsets[nextOfFirst] : 0);
  });
  return Buffer.from(bytes.subarray(0, dataPos));
}

function fakeExif(orientation) {
  return buildTiff([
    [ // 0: main list
      [0x010F, 2, 'Apple'], [0x0110, 2, 'iPhone 15 Pro'], [0x0112, 3, [orientation]],
      [0x0131, 2, '17.4.1'], [0x0132, 2, '2024:05:12 15:00:00'], [0x013B, 2, 'Jane Doe'],
      [0x8769, 4, { pointer: 1 }], [0x8825, 4, { pointer: 2 }]
    ],
    [ // 1: EXIF details
      [0x9003, 2, '2024:05:12 14:33:09'], [0x9011, 2, '+02:00'],
      [0xA431, 2, 'SN-123456'], [0xA434, 2, 'iPhone 15 Pro back camera 6.86mm f/1.78']
    ],
    [ // 2: GPS (the Eiffel Tower)
      [0x0001, 2, 'N'], [0x0002, 5, [[48, 1], [51, 1], [3024, 100]]],
      [0x0003, 2, 'E'], [0x0004, 5, [[2, 1], [17, 1], [4020, 100]]],
      [0x0005, 1, [0]], [0x0006, 5, [[35, 1]]]
    ],
    [ // 3: thumbnail
      [0x0201, 4, 0], [0x0202, 4, 0]
    ]
  ], 3);
}

const FAKE_XMP = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description ' +
  'xmp:CreatorTool="Adobe Lightroom" photoshop:City="Paris" photoshop:Country="France" ' +
  'exif:GPSLatitude="48,51.504N" exif:GPSLongitude="2,17.67E">' +
  '<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">© Jane Doe 2024</rdf:li></rdf:Alt></dc:rights>' +
  '<xmpMM:History><rdf:Seq><rdf:li>edited</rdf:li></rdf:Seq></xmpMM:History>' +
  '</rdf:Description></rdf:RDF></x:xmpmeta>';

function fakeIptc() {
  const field = (number, text) => {
    const value = Buffer.from(text);
    return Buffer.concat([Buffer.from([0x1C, 2, number, value.length >> 8, value.length & 0xFF]), value]);
  };
  const iptc = Buffer.concat([field(80, 'Jane Doe'), field(120, 'Holiday in Paris')]);
  const size = Buffer.alloc(4); size.writeUInt32BE(iptc.length);
  return Buffer.concat([Buffer.from('Photoshop 3.0\0', 'latin1'), Buffer.from('8BIM'), Buffer.from([0x04, 0x04, 0, 0]), size, iptc]);
}

function jpegSegment(marker, content) {
  const header = Buffer.from([0xFF, marker, 0, 0]);
  header.writeUInt16BE(content.length + 2, 2);
  return Buffer.concat([header, content]);
}

function pngChunk(type, content) {
  return Buffer.from(app.makePngChunk(type, new Uint8Array(content)));
}

// The parts of a file that make up the picture itself.
function jpegPictureParts(bytes) {
  const { segments } = app.splitJpeg(bytes);
  return Buffer.concat(segments
    .filter((s) => !(s.marker >= 0xE0 && s.marker <= 0xEF) && s.marker !== 0xFE)
    .map((s) => Buffer.from(bytes.subarray(s.start, s.end))));
}

function pngPictureParts(bytes) {
  const { chunks } = app.splitPng(bytes);
  return Buffer.concat(chunks.filter((c) => ['IHDR', 'IDAT', 'IEND'].includes(c.type)).map((c) => Buffer.from(c.content)));
}

// Asks macOS (sips) to decode a photo into raw pixels, to prove the picture is identical.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanshare-'));
function decodePixels(bytes, name) {
  const input = path.join(tempDir, name);
  const output = input + '.bmp';
  fs.writeFileSync(input, bytes);
  execFileSync('sips', ['-s', 'format', 'bmp', input, '--out', output], { stdio: 'ignore' });
  return fs.readFileSync(output);
}
let hasSips = true;
try { execFileSync('which', ['sips'], { stdio: 'ignore' }); } catch (e) { hasSips = false; }

function printReport(report) {
  for (const item of report.items) console.log('      [' + item.category + '] ' + item.label + ': ' + item.value);
}

// ---------------------------------------------------------------------------
// JPEG test
// ---------------------------------------------------------------------------

console.log('\nJPEG photo with lots of hidden info');
const base = fs.readFileSync(path.join(__dirname, 'sample.jpg'));
const dirtyJpeg = new Uint8Array(Buffer.concat([
  base.subarray(0, 2),                                   // start of image
  jpegSegment(0xE1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), fakeExif(6)])),
  jpegSegment(0xE1, Buffer.from('http://ns.adobe.com/xap/1.0/\0' + FAKE_XMP)),
  jpegSegment(0xED, fakeIptc()),
  jpegSegment(0xFE, Buffer.from('Secret comment')),
  jpegSegment(0xE2, Buffer.from('MPF\0 fake multi-picture info')),
  base.subarray(2),                                      // the real photo
  Buffer.from('FAKE DEPTH MAP IMAGE DATA')               // data after the end
]));

const jpegReport = app.readMetadata(dirtyJpeg);
printReport(jpegReport);
const labels = jpegReport.items.map((i) => i.label);
check('finds the GPS location', jpegReport.location && Math.abs(jpegReport.location.lat - 48.8584) < 0.001);
for (const label of ['Phone or camera', 'Taken on', 'Author', 'Copyright', 'Place name', 'Camera serial number',
                     'Comment', 'Preview thumbnail', 'Editing history', 'Extra hidden data', 'Other technical data']) {
  check('finds "' + label + '"', labels.includes(label));
}

const cleanJpeg = app.removeMetadata(dirtyJpeg);
const cleanJpegReport = app.readMetadata(cleanJpeg);
check('clean copy has no hidden info left', cleanJpegReport.items.length === 0);
check('clean copy keeps the rotation (6 = turned 90°)', cleanJpegReport.orientation === 6);
check('picture data is byte-for-byte identical', sameBytes(jpegPictureParts(dirtyJpeg), jpegPictureParts(cleanJpeg)));
check('fake GPS text is gone from the file', !Buffer.from(cleanJpeg).includes('Jane Doe') && !Buffer.from(cleanJpeg).includes('Paris'));
check('extra data after the end is removed', !Buffer.from(cleanJpeg).includes('FAKE DEPTH'));
check('cleaning twice gives the same result', sameBytes(app.removeMetadata(cleanJpeg), cleanJpeg));
if (hasSips) check('decoded pixels are identical (checked with macOS sips)', sameBytes(decodePixels(dirtyJpeg, 'a.jpg'), decodePixels(cleanJpeg, 'b.jpg')));

// ---------------------------------------------------------------------------
// PNG test
// ---------------------------------------------------------------------------

console.log('\nPNG image with lots of hidden info');
const width = 64, height = 48;
const rows = Buffer.alloc((width * 3 + 1) * height);
for (let i = 0; i < rows.length; i++) rows[i] = (i * 7) % 251;
for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
const header = Buffer.alloc(13);
header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;

const plainPng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  pngChunk('IHDR', header),
  pngChunk('IDAT', zlib.deflateSync(rows)),
  pngChunk('IEND', Buffer.alloc(0))
]);
const ihdrEnd = 8 + 25;
const dirtyPng = new Uint8Array(Buffer.concat([
  plainPng.subarray(0, ihdrEnd),
  pngChunk('eXIf', fakeExif(3)),
  pngChunk('tEXt', Buffer.from('Author\0Jane Doe', 'latin1')),
  pngChunk('tEXt', Buffer.from('Software\0GIMP 2.10', 'latin1')),
  pngChunk('zTXt', Buffer.from('Comment\0\0xyz', 'latin1')),
  pngChunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0' + FAKE_XMP)),
  pngChunk('tIME', Buffer.from([0x07, 0xE8, 5, 12, 14, 33, 9])),
  pngChunk('prVt', Buffer.from('private app data')),
  plainPng.subarray(ihdrEnd),
  Buffer.from('trailing junk')
]));

const pngReport = app.readMetadata(dirtyPng);
printReport(pngReport);
const pngLabels = pngReport.items.map((i) => i.label);
check('finds the GPS location', !!pngReport.location);
for (const label of ['Phone or camera', 'Author', 'Software used', 'Last changed on', 'Comment', 'Place name', 'Other technical data', 'Extra hidden data']) {
  check('finds "' + label + '"', pngLabels.includes(label));
}

const cleanPng = app.removeMetadata(dirtyPng);
const cleanPngReport = app.readMetadata(cleanPng);
check('clean copy has no hidden info left', cleanPngReport.items.length === 0);
check('clean copy keeps the rotation (3 = upside down)', cleanPngReport.orientation === 3);
check('picture data is byte-for-byte identical', sameBytes(pngPictureParts(dirtyPng), pngPictureParts(cleanPng)));
check('every chunk checksum in the clean copy is valid', app.splitPng(cleanPng).chunks.every((c) => {
  const stored = Buffer.from(cleanPng.subarray(c.end - 4, c.end)).readUInt32BE();
  return stored === app.crc32(cleanPng.subarray(c.start + 4, c.end - 4));
}));
check('a PNG with nothing hidden is left exactly as it was', sameBytes(app.removeMetadata(new Uint8Array(plainPng)), plainPng));
if (hasSips) check('decoded pixels are identical (checked with macOS sips)', sameBytes(decodePixels(dirtyPng, 'a.png'), decodePixels(cleanPng, 'b.png')));

// ---------------------------------------------------------------------------
// Other files
// ---------------------------------------------------------------------------

console.log('\nOther files');
check('recognises a HEIC (iPhone) photo', app.detectFileType(new Uint8Array(Buffer.from('\0\0\0\x18ftypheic', 'latin1'))) === 'heic');
check('rejects a text file', app.detectFileType(new Uint8Array(Buffer.from('hello world'))) === 'unknown');
let message = '';
try { app.removeMetadata(dirtyJpeg.subarray(0, 30)); } catch (error) { message = error.message; }
check('a damaged JPEG gives a friendly error', message === 'This JPEG file seems to be damaged.');

fs.rmSync(tempDir, { recursive: true, force: true });
console.log(failures === 0 ? '\nAll tests passed.\n' : '\n' + failures + ' test(s) failed.\n');
process.exit(failures === 0 ? 0 : 1);
