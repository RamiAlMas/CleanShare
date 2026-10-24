// app.js
// Connects the page to the cleaning logic in metadata.js:
// picking or dropping a photo, showing what was found, and the download button.

const startView = document.getElementById('start-view');
const resultView = document.getElementById('result-view');
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const chooseButton = document.getElementById('choose-button');
const errorBox = document.getElementById('error');
const preview = document.getElementById('preview');
const fileName = document.getElementById('file-name');
const fileInfo = document.getElementById('file-info');
const summary = document.getElementById('summary');
const summaryTitle = document.getElementById('summary-title');
const summaryText = document.getElementById('summary-text');
const findings = document.getElementById('findings');
const downloadButton = document.getElementById('download-button');
const resetButton = document.getElementById('reset-button');
const verified = document.getElementById('verified');

// The groups shown in the results, in this order.
const CATEGORIES = [
  { id: 'location', title: 'Location', icon: '📍' },
  { id: 'device', title: 'Device', icon: '📱' },
  { id: 'time', title: 'Date and time', icon: '🕒' },
  { id: 'people', title: 'People and copyright', icon: '👤' },
  { id: 'other', title: 'Other details', icon: '📝' }
];

// A temporary link to the clean file, held in the browser's memory.
let cleanFileUrl = null;

// --- Choosing a file -------------------------------------------------------

chooseButton.addEventListener('click', (event) => {
  event.stopPropagation();
  fileInput.click();
});

// Tapping anywhere in the drop zone also opens the file picker.
dropZone.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  handleFile(fileInput.files[0]);
  fileInput.value = ''; // lets the same file be chosen again later
});

// --- Drag and drop (anywhere on the page) -----------------------------------

window.addEventListener('dragover', (event) => {
  event.preventDefault(); // stops the browser from opening the photo itself
  if (!startView.hidden) dropZone.classList.add('dragging');
});

window.addEventListener('dragleave', (event) => {
  if (event.relatedTarget === null) dropZone.classList.remove('dragging');
});

window.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('dragging');
  if (!startView.hidden) handleFile(event.dataTransfer.files[0]);
});

resetButton.addEventListener('click', showStartView);

// --- Checking and cleaning the photo ----------------------------------------

async function handleFile(file) {
  if (!file) return;
  hideError();

  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    showError('Sorry, this file could not be opened.');
    return;
  }

  const type = detectFileType(bytes);
  if (type === 'heic') {
    showError('This is a HEIC photo (the iPhone format), which isn\'t supported yet. Tip: share it from your iPhone as "Most Compatible" or export it as JPEG, then try again.');
    return;
  }
  if (type === 'unknown') {
    showError('This file isn\'t a JPEG or PNG photo. CleanShare only supports those two formats for now.');
    return;
  }

  try {
    const report = readMetadata(bytes);
    const cleanBytes = removeMetadata(bytes);
    // Double-check our own work: the clean copy should contain nothing.
    const isVerified = readMetadata(cleanBytes).items.length === 0;
    showResult(file, report, cleanBytes, isVerified);
  } catch (error) {
    showError(error.message || 'Sorry, something went wrong while reading this photo.');
  }
}

// --- Showing the results ----------------------------------------------------

function showResult(file, report, cleanBytes, isVerified) {
  const mimeType = report.type === 'png' ? 'image/png' : 'image/jpeg';
  if (cleanFileUrl) URL.revokeObjectURL(cleanFileUrl);
  cleanFileUrl = URL.createObjectURL(new Blob([cleanBytes], { type: mimeType }));

  preview.src = cleanFileUrl;
  preview.alt = 'Preview of ' + file.name;
  fileName.textContent = file.name;
  fileInfo.textContent = report.type.toUpperCase() + ' · ' + formatSize(file.size) +
    ' → clean copy ' + formatSize(cleanBytes.length);

  downloadButton.href = cleanFileUrl;
  downloadButton.download = makeCleanFileName(file.name, report.type);

  // The summary box at the top.
  const count = report.items.length;
  if (report.location) {
    summary.className = 'summary danger';
    summaryTitle.textContent = 'This photo reveals where it was taken';
    summaryText.textContent = 'Anyone you send it to could see the exact location. We found ' +
      count + ' piece' + (count === 1 ? '' : 's') + ' of hidden info in total.';
  } else if (count > 0) {
    summary.className = 'summary warning';
    summaryTitle.textContent = 'We found ' + count + ' piece' + (count === 1 ? '' : 's') + ' of hidden info';
    summaryText.textContent = 'Download the clean copy to share this photo without it.';
  } else {
    summary.className = 'summary safe';
    summaryTitle.textContent = 'No hidden info found';
    summaryText.textContent = 'This photo looks clean already. You can still download a copy if you like.';
  }

  // The list of findings, grouped by category.
  findings.replaceChildren();
  for (const category of CATEGORIES) {
    const items = report.items.filter((item) => item.category === category.id);
    if (items.length === 0) continue;

    const group = document.createElement('section');
    group.className = 'finding-group';
    const heading = document.createElement('h3');
    heading.textContent = category.icon + ' ' + category.title;
    const list = document.createElement('dl');
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'finding';
      const label = document.createElement('dt');
      label.textContent = item.label;
      const value = document.createElement('dd');
      value.textContent = item.value;
      row.append(label, value);
      list.append(row);
    }
    group.append(heading, list);
    findings.append(group);
  }

  if (isVerified) {
    verified.className = 'verified';
    verified.textContent = count > 0
      ? '✓ Checked: the clean copy contains none of this info, and the image quality is exactly the same.'
      : '✓ Image quality is exactly the same as the original.';
  } else {
    verified.className = 'verified not-verified';
    verified.textContent = 'Some info could not be removed from this file. Please don\'t rely on this copy.';
  }

  startView.hidden = true;
  resultView.hidden = false;
  window.scrollTo(0, 0);
  summary.focus({ preventScroll: true }); // helps screen-reader users
}

function showStartView() {
  if (cleanFileUrl) URL.revokeObjectURL(cleanFileUrl);
  cleanFileUrl = null;
  preview.removeAttribute('src');
  resultView.hidden = true;
  startView.hidden = false;
  chooseButton.focus();
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function hideError() {
  errorBox.hidden = true;
}

// "holiday.jpg" -> "holiday-clean.jpg"
function makeCleanFileName(originalName, type) {
  const match = originalName.match(/^(.*?)(\.[^.]*)?$/);
  const baseName = match[1] || 'photo';
  const extension = type === 'png' ? '.png' : (/^\.jpe?g$/i.test(match[2] || '') ? match[2] : '.jpg');
  return baseName + '-clean' + extension;
}
