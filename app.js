// Private encrypted album viewer.
// Nothing here is a "password check" — the keyword derives an AES-GCM key,
// and decryption either works or throws. A wrong keyword produces a
// generic error via that failure, never a separate comparison.

const paramsPromise = fetch('photos/params.json').then((r) => r.json());
const manifestPromise = fetch('photos/manifest.bin').then((r) => r.arrayBuffer());

const lockScreen = document.getElementById('lock-screen');
const galleryScreen = document.getElementById('gallery-screen');
const lockForm = document.getElementById('lock-form');
const keywordInput = document.getElementById('keyword-input');
const unlockBtn = document.getElementById('unlock-btn');
const lockError = document.getElementById('lock-error');

const albumTitleEl = document.getElementById('album-title');
const albumMessageEl = document.getElementById('album-message');
const gridEl = document.getElementById('grid');

const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');
const lightboxCaption = document.getElementById('lightbox-caption');
const lightboxDate = document.getElementById('lightbox-date');
const lightboxClose = document.getElementById('lightbox-close');
const lightboxPrev = document.getElementById('lightbox-prev');
const lightboxNext = document.getElementById('lightbox-next');

let derivedKey = null;
let manifest = null;
let currentLightboxIndex = -1;
let currentLightboxUrl = null;

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKeyFromKeyword(keyword, saltBytes, iterations) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(keyword),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
}

async function decryptToBytes(key, buffer) {
  const bytes = new Uint8Array(buffer);
  const iv = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new Uint8Array(plain);
}

async function fetchAndDecryptImage(key, url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('network');
  const buffer = await res.arrayBuffer();
  const plainBytes = await decryptToBytes(key, buffer);
  const blob = new Blob([plainBytes], { type: 'image/jpeg' });
  return URL.createObjectURL(blob);
}

// Small concurrency-capped queue so a big album doesn't fire every
// thumbnail request at once.
async function runWithConcurrency(items, limit, worker) {
  let next = 0;
  async function runNext() {
    const i = next++;
    if (i >= items.length) return;
    await worker(items[i], i);
    await runNext();
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, runNext);
  await Promise.all(runners);
}

lockForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const keyword = keywordInput.value;
  if (!keyword) return;

  unlockBtn.disabled = true;
  unlockBtn.textContent = 'Unlocking…';
  lockError.hidden = true;

  try {
    const [params, manifestBuffer] = await Promise.all([paramsPromise, manifestPromise]);
    const saltBytes = base64ToBytes(params.saltB64);
    const key = await deriveKeyFromKeyword(keyword, saltBytes, params.iterations);

    let manifestBytes;
    try {
      manifestBytes = await decryptToBytes(key, manifestBuffer);
    } catch {
      lockError.textContent = 'Wrong keyword. Please try again.';
      lockError.hidden = false;
      unlockBtn.disabled = false;
      unlockBtn.textContent = 'Unlock';
      return;
    }

    derivedKey = key;
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    showGallery();
  } catch (err) {
    console.error(err);
    lockError.textContent = "Couldn't load the album. Check your connection and try again.";
    lockError.hidden = false;
    unlockBtn.disabled = false;
    unlockBtn.textContent = 'Unlock';
  }
});

function showGallery() {
  lockScreen.hidden = true;
  galleryScreen.hidden = false;

  albumTitleEl.textContent = manifest.title || '';
  albumMessageEl.textContent = manifest.message || '';

  gridEl.innerHTML = '';
  const cells = manifest.photos.map((photo) => {
    const cell = document.createElement('div');
    cell.className = 'grid-item';

    const img = document.createElement('img');
    img.alt = photo.caption || '';
    cell.appendChild(img);

    if (photo.caption) {
      const caption = document.createElement('div');
      caption.className = 'grid-caption';
      caption.textContent = photo.caption;
      cell.appendChild(caption);
    }

    cell.addEventListener('click', () => openLightbox(photo.id));
    gridEl.appendChild(cell);
    return { cell, img };
  });

  runWithConcurrency(manifest.photos, 6, async (photo, idx) => {
    const { cell, img } = cells[idx];
    try {
      const url = await fetchAndDecryptImage(derivedKey, `photos/thumbs/${photo.id}.bin`);
      img.src = url;
      img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
    } catch (err) {
      console.error('thumbnail failed', photo.id, err);
      cell.classList.add('error');
    }
  });
}

async function openLightbox(id) {
  const index = manifest.photos.findIndex((p) => p.id === id);
  if (index === -1) return;
  currentLightboxIndex = index;
  lightbox.hidden = false;
  await showLightboxPhoto(index);
}

async function showLightboxPhoto(index) {
  const photo = manifest.photos[index];
  currentLightboxIndex = index;

  lightboxCaption.textContent = photo.caption || '';
  lightboxDate.textContent = photo.date || '';
  lightboxImg.src = '';
  lightboxPrev.disabled = index === 0;
  lightboxNext.disabled = index === manifest.photos.length - 1;

  try {
    const url = await fetchAndDecryptImage(derivedKey, `photos/full/${photo.id}.bin`);
    if (currentLightboxUrl) URL.revokeObjectURL(currentLightboxUrl);
    currentLightboxUrl = url;
    lightboxImg.src = url;
  } catch (err) {
    console.error('full image failed', photo.id, err);
    lightboxCaption.textContent = "Couldn't load this photo.";
  }
}

function closeLightbox() {
  lightbox.hidden = true;
  if (currentLightboxUrl) {
    URL.revokeObjectURL(currentLightboxUrl);
    currentLightboxUrl = null;
  }
  currentLightboxIndex = -1;
}

lightboxClose.addEventListener('click', closeLightbox);
lightbox.addEventListener('click', (e) => {
  if (e.target === lightbox) closeLightbox();
});
lightboxPrev.addEventListener('click', () => {
  if (currentLightboxIndex > 0) showLightboxPhoto(currentLightboxIndex - 1);
});
lightboxNext.addEventListener('click', () => {
  if (currentLightboxIndex < manifest.photos.length - 1) showLightboxPhoto(currentLightboxIndex + 1);
});

document.addEventListener('keydown', (e) => {
  if (lightbox.hidden) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft' && currentLightboxIndex > 0) showLightboxPhoto(currentLightboxIndex - 1);
  if (e.key === 'ArrowRight' && currentLightboxIndex < manifest.photos.length - 1) {
    showLightboxPhoto(currentLightboxIndex + 1);
  }
});
