# CleanShare

CleanShare is a small web app that helps people share photos safely. A person drops a photo onto the page and the app:

1. Shows them, in plain everyday words, what hidden information the file contains (GPS location, phone/camera model, date and time, author names, editing software, etc.).
2. Lets them download a clean copy with that hidden information removed, in one click.

The owner of this project is a beginner. Keep code simple and readable, and after each change explain what was done in plain language.

## Rules (must always be followed)

- **Plain HTML, CSS and JavaScript only.** No frameworks (React, Vue, etc.), no build tools (npm, bundlers, TypeScript), no CDN libraries.
- **Files never leave the user's device.** All reading and cleaning happens in the browser. No uploads, no analytics, no external requests of any kind. A Content Security Policy in `index.html` enforces this. Never loosen it.
- **Never re-compress images.** Metadata is removed by copying the file's image blocks byte for byte and skipping the metadata blocks. Never draw the photo to a canvas and re-export it, because that lowers quality.
- The app must open by double-clicking `index.html` (no server needed), so use classic `<script>` tags, not ES modules.
- Must work well on mobile and in light and dark mode.

## Files

- `index.html`: page structure and the Content Security Policy.
- `style.css`: all styling (colors are CSS variables at the top; dark mode is included).
- `metadata.js`: the core logic, with no page/UI code. `readMetadata(bytes)` lists the hidden info found; `removeMetadata(bytes)` returns a clean copy. Supports JPEG and PNG.
- `app.js`: page behavior (drag and drop, file picker, showing results, download button).

## How cleaning works

- **JPEG:** keeps the image data, the color profile (ICC) and the Adobe color block. Removes EXIF, XMP, IPTC/Photoshop, comments, embedded thumbnails and any extra data after the end of the image (e.g. phone depth/HDR images). If the photo had a rotation ("orientation") tag, a tiny new EXIF block containing *only* the rotation is written back, so the photo doesn't appear sideways.
- **PNG:** keeps the image, transparency, color and animation chunks. Removes text chunks (tEXt/zTXt/iTXt, including XMP), eXIf and tIME, plus any unknown optional chunks. The rotation tag is preserved the same way as for JPEG.

## Testing

`tests/run-tests.js` (run with `node tests/run-tests.js`) builds sample photos with fake GPS and camera info, cleans them, and checks that the info is gone and the image data is unchanged.

## Not supported yet

HEIC/HEIF, WebP, multiple files at once.
