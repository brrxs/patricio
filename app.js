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

const introScreen = document.getElementById('intro-screen');
const introMessageEl = document.getElementById('intro-message');
const introPdfLink = document.getElementById('intro-pdf-link');
const introContinueBtn = document.getElementById('intro-continue-btn');

const albumTitleEl = document.getElementById('album-title');
const albumMessageEl = document.getElementById('album-message');
const tabsEl = document.getElementById('tabs');
const gridContainerEl = document.getElementById('grid-container');

const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');
const lightboxCaption = document.getElementById('lightbox-caption');
const lightboxDate = document.getElementById('lightbox-date');
const lightboxClose = document.getElementById('lightbox-close');
const lightboxPrev = document.getElementById('lightbox-prev');
const lightboxNext = document.getElementById('lightbox-next');

let derivedKey = null;
let manifest = null;
let groups = []; // [{ name, photos: [...] }], in first-seen order
let activeGroupPhotos = []; // the photo list backing the currently visible tab
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

async function fetchAndDecryptBlob(key, url, mimeType) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('network');
  const buffer = await res.arrayBuffer();
  const plainBytes = await decryptToBytes(key, buffer);
  const blob = new Blob([plainBytes], { type: mimeType });
  return URL.createObjectURL(blob);
}

function fetchAndDecryptImage(key, url) {
  return fetchAndDecryptBlob(key, url, 'image/jpeg');
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

    if (manifest.intro && (manifest.intro.message || manifest.intro.hasPdf)) {
      showIntro();
    } else {
      showGallery();
    }
  } catch (err) {
    console.error(err);
    lockError.textContent = "Couldn't load the album. Check your connection and try again.";
    lockError.hidden = false;
    unlockBtn.disabled = false;
    unlockBtn.textContent = 'Unlock';
  }
});

let introPdfUrl = null;

function showIntro() {
  lockScreen.hidden = true;
  introScreen.hidden = false;

  introMessageEl.textContent = manifest.intro.message || '';
  introPdfLink.hidden = !manifest.intro.hasPdf;
}

introPdfLink.addEventListener('click', async (e) => {
  e.preventDefault();
  if (introPdfUrl) {
    window.open(introPdfUrl, '_blank');
    return;
  }
  const originalText = introPdfLink.textContent;
  introPdfLink.textContent = 'Loading…';
  try {
    introPdfUrl = await fetchAndDecryptBlob(derivedKey, 'photos/intro.pdf.bin', 'application/pdf');
    introPdfLink.textContent = originalText;
    window.open(introPdfUrl, '_blank');
  } catch (err) {
    console.error('intro pdf failed', err);
    introPdfLink.textContent = "Couldn't load — try again";
  }
});

introContinueBtn.addEventListener('click', () => {
  introScreen.hidden = true;
  showGallery();
});

function groupPhotos(photos) {
  const byName = new Map();
  for (const photo of photos) {
    const name = photo.group || 'Photos';
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(photo);
  }
  return Array.from(byName, ([name, groupPhotos]) => ({ name, photos: groupPhotos }));
}

function showGallery() {
  lockScreen.hidden = true;
  galleryScreen.hidden = false;

  albumTitleEl.textContent = manifest.title || '';
  albumMessageEl.textContent = manifest.message || '';

  groups = groupPhotos(manifest.photos);

  tabsEl.innerHTML = '';
  gridContainerEl.innerHTML = '';
  tabsEl.hidden = groups.length <= 1;

  const allCells = [];

  groups.forEach((group, groupIndex) => {
    const tabBtn = document.createElement('button');
    tabBtn.type = 'button';
    tabBtn.className = 'tab-btn';
    tabBtn.textContent = group.name;
    tabBtn.addEventListener('click', () => selectGroup(groupIndex));
    tabsEl.appendChild(tabBtn);
    group.tabBtn = tabBtn;

    const section = document.createElement('section');
    section.className = 'grid';
    section.hidden = groupIndex !== 0;
    gridContainerEl.appendChild(section);
    group.sectionEl = section;

    group.photos.forEach((photo) => {
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

      cell.addEventListener('click', () => openLightbox(group.photos, photo.id));
      section.appendChild(cell);
      allCells.push({ cell, img, photo });
    });
  });

  selectGroup(0);

  runWithConcurrency(allCells, 6, async ({ cell, img, photo }) => {
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

function selectGroup(index) {
  groups.forEach((group, i) => {
    const active = i === index;
    group.sectionEl.hidden = !active;
    group.tabBtn.classList.toggle('active', active);
    if (active) activeGroupPhotos = group.photos;
  });
}

async function openLightbox(groupPhotos, id) {
  activeGroupPhotos = groupPhotos;
  const index = groupPhotos.findIndex((p) => p.id === id);
  if (index === -1) return;
  currentLightboxIndex = index;
  lightbox.hidden = false;
  await showLightboxPhoto(index);
}

async function showLightboxPhoto(index) {
  const photo = activeGroupPhotos[index];
  currentLightboxIndex = index;

  lightboxCaption.textContent = photo.caption || '';
  lightboxDate.textContent = photo.date || '';
  lightboxImg.src = '';
  lightboxPrev.disabled = index === 0;
  lightboxNext.disabled = index === activeGroupPhotos.length - 1;

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
  if (currentLightboxIndex < activeGroupPhotos.length - 1) showLightboxPhoto(currentLightboxIndex + 1);
});

document.addEventListener('keydown', (e) => {
  if (lightbox.hidden) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft' && currentLightboxIndex > 0) showLightboxPhoto(currentLightboxIndex - 1);
  if (e.key === 'ArrowRight' && currentLightboxIndex < activeGroupPhotos.length - 1) {
    showLightboxPhoto(currentLightboxIndex + 1);
  }
});
