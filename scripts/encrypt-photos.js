// Author-side tool: encrypts photos from source/ into photos/ for the site
// to serve. Never runs on GitHub Pages itself — only on your own machine,
// whenever you add or change photos.
//
// Usage: npm run encrypt

const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const sharp = require('sharp');
const heicConvert = require('heic-convert');

const HEIC_EXTENSIONS = new Set(['.heic', '.heif']);

// sharp's bundled libheif can read HEIC metadata but can't decode the
// HEVC pixel data in prebuilt binaries (a licensing-driven limitation), so
// HEIC/HEIF files are pre-converted to JPEG with a pure-JS decoder first.
async function loadImageBuffer(filePath) {
  const buf = fs.readFileSync(filePath);
  if (HEIC_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return heicConvert({ buffer: buf, format: 'JPEG', quality: 0.95 });
  }
  return buf;
}

const subtle = webcrypto.subtle;
const ITERATIONS = 250000;

const ROOT_DIR = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT_DIR, 'source');
const CONTENT_PATH = path.join(SOURCE_DIR, 'content.json');
const PHOTOS_DIR = path.join(ROOT_DIR, 'photos');

function scaffoldSource() {
  fs.mkdirSync(SOURCE_DIR, { recursive: true });

  fs.writeFileSync(
    path.join(SOURCE_DIR, 'README.md'),
    `This folder is local-only (gitignored) — it never gets committed or pushed.

Put your raw photo files directly in here, and edit content.json to list
them in the order you want them to appear, with a caption for each.
`
  );

  fs.writeFileSync(
    CONTENT_PATH,
    JSON.stringify(
      {
        title: 'For You',
        message: 'A few of my favorite moments with you.',
        photos: [
          {
            file: 'example.jpg',
            caption: 'Replace this with your own photo and caption',
            date: '2026-01-01',
            group: 'Optional tab name, e.g. "Italy" — omit for a single ungrouped tab',
          },
        ],
      },
      null,
      2
    ) + '\n'
  );

  console.log('Created source/ — this folder is gitignored and stays on your computer only.\n');
  console.log('Next steps:');
  console.log('  1. Copy your photos into source/');
  console.log('  2. Edit source/content.json: set a title, message, and one entry per photo');
  console.log('     ("file" must match a filename you copied into source/, "date" is optional)');
  console.log('  3. Run `npm run encrypt` again.\n');
}

function validateContent(content) {
  const errors = [];
  if (typeof content.title !== 'string') errors.push('"title" must be a string');
  if (typeof content.message !== 'string') errors.push('"message" must be a string');
  if (content.intro !== undefined && content.intro !== null) {
    if (typeof content.intro !== 'object') {
      errors.push('"intro" must be an object');
    } else {
      if (typeof content.intro.message !== 'string') errors.push('"intro.message" must be a string');
      if (
        content.intro.pdf !== undefined &&
        content.intro.pdf !== null &&
        typeof content.intro.pdf !== 'string'
      ) {
        errors.push('"intro.pdf" must be a string or omitted');
      }
    }
  }
  if (!Array.isArray(content.photos) || content.photos.length === 0) {
    errors.push('"photos" must be a non-empty array');
  } else {
    content.photos.forEach((p, i) => {
      if (typeof p.file !== 'string' || !p.file) {
        errors.push(`photos[${i}]: "file" must be a non-empty string`);
      }
      if (typeof p.caption !== 'string') {
        errors.push(`photos[${i}]: "caption" must be a string (use "" for none)`);
      }
      if (p.date !== undefined && p.date !== null && typeof p.date !== 'string') {
        errors.push(`photos[${i}]: "date" must be a string or omitted`);
      }
      if (p.group !== undefined && p.group !== null && typeof p.group !== 'string') {
        errors.push(`photos[${i}]: "group" must be a string or omitted`);
      }
    });
  }
  return errors;
}

function findMissingFiles(content) {
  const files = content.photos.map((p) => p.file);
  if (content.intro && content.intro.pdf) files.push(content.intro.pdf);
  return files
    .filter((file) => typeof file === 'string' && file)
    .filter((file) => !fs.existsSync(path.join(SOURCE_DIR, file)));
}

// Reads a line of input from the terminal without echoing it, printing "*"
// per character instead. Keyed off character codes (not literal control
// characters in source) to keep this file plain, portable ASCII.
function promptMasked(question) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    let input = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const CODE_LF = 10;
    const CODE_CR = 13;
    const CODE_EOF = 4; // Ctrl-D
    const CODE_INTERRUPT = 3; // Ctrl-C
    const CODE_BACKSPACE = 8;
    const CODE_DEL = 127;

    function finish() {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
      resolve(input);
    }

    function onData(chunk) {
      const code = chunk.charCodeAt(0);
      if (chunk.length === 1 && (code === CODE_LF || code === CODE_CR || code === CODE_EOF)) {
        finish();
        return;
      }
      if (chunk.length === 1 && code === CODE_INTERRUPT) {
        stdout.write('\n');
        process.exit(1);
      }
      if (chunk.length === 1 && (code === CODE_BACKSPACE || code === CODE_DEL)) {
        if (input.length > 0) {
          input = input.slice(0, -1);
          stdout.write(String.fromCharCode(CODE_BACKSPACE) + ' ' + String.fromCharCode(CODE_BACKSPACE));
        }
        return;
      }
      input += chunk;
      stdout.write('*');
    }

    stdin.on('data', onData);
  });
}

async function getKeyword() {
  if (!process.stdin.isTTY) {
    // A masked prompt needs a real terminal. Fall back to an env var so the
    // script still works in non-interactive contexts (e.g. automated testing)
    // instead of hanging forever waiting for input that will never come.
    if (process.env.ALBUM_KEYWORD) {
      console.log('Using ALBUM_KEYWORD from the environment (non-interactive mode).');
      return process.env.ALBUM_KEYWORD;
    }
    console.error('stdin is not an interactive terminal, so the masked keyword prompt cannot run.');
    console.error('Run this from a real terminal, or set the ALBUM_KEYWORD environment variable.');
    process.exit(1);
  }

  const first = await promptMasked('Choose a keyword: ');
  if (!first) {
    console.error('Keyword cannot be empty.');
    process.exit(1);
  }
  const second = await promptMasked('Confirm keyword: ');
  if (first !== second) {
    console.error('Keywords did not match. Nothing was written.');
    process.exit(1);
  }
  return first;
}

async function deriveKey(keyword, salt, iterations) {
  const enc = new TextEncoder();
  const baseKey = await subtle.importKey('raw', enc.encode(keyword), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
}

async function encryptBytes(key, plainBuffer) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const cipher = await subtle.encrypt({ name: 'AES-GCM', iv }, key, plainBuffer);
  return Buffer.concat([Buffer.from(iv), Buffer.from(cipher)]);
}

async function main() {
  if (!fs.existsSync(CONTENT_PATH)) {
    scaffoldSource();
    return;
  }

  const content = JSON.parse(fs.readFileSync(CONTENT_PATH, 'utf8'));
  const errors = validateContent(content);
  const missing = errors.length === 0 ? findMissingFiles(content) : [];

  if (errors.length || missing.length) {
    console.error('Problems found in source/content.json:\n');
    errors.forEach((e) => console.error('  - ' + e));
    missing.forEach((f) => console.error(`  - missing file: source/${f}`));
    console.error('');
    process.exit(1);
  }

  const keyword = await getKeyword();

  fs.rmSync(PHOTOS_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(PHOTOS_DIR, 'thumbs'), { recursive: true });
  fs.mkdirSync(path.join(PHOTOS_DIR, 'full'), { recursive: true });

  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(keyword, salt, ITERATIONS);

  const manifestPhotos = [];
  for (let i = 0; i < content.photos.length; i++) {
    const p = content.photos[i];
    const buf = await loadImageBuffer(path.join(SOURCE_DIR, p.file));

    const thumbBuf = await sharp(buf)
      .rotate() // bake in the EXIF orientation — sharp strips metadata otherwise, losing it
      .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    const fullBuf = await sharp(buf)
      .rotate()
      .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    const thumbEnc = await encryptBytes(key, thumbBuf);
    const fullEnc = await encryptBytes(key, fullBuf);

    fs.writeFileSync(path.join(PHOTOS_DIR, 'thumbs', `${i}.bin`), thumbEnc);
    fs.writeFileSync(path.join(PHOTOS_DIR, 'full', `${i}.bin`), fullEnc);

    manifestPhotos.push({ id: i, caption: p.caption, date: p.date ?? null, group: p.group ?? null });
    console.log(`  encrypted ${i + 1}/${content.photos.length}: ${p.file}`);
  }

  let introHasPdf = false;
  if (content.intro && content.intro.pdf) {
    const pdfBuf = fs.readFileSync(path.join(SOURCE_DIR, content.intro.pdf));
    const pdfEnc = await encryptBytes(key, pdfBuf);
    fs.writeFileSync(path.join(PHOTOS_DIR, 'intro.pdf.bin'), pdfEnc);
    introHasPdf = true;
    console.log(`  encrypted intro PDF: ${content.intro.pdf}`);
  }

  const manifest = {
    title: content.title,
    message: content.message,
    intro: content.intro ? { message: content.intro.message, hasPdf: introHasPdf } : null,
    photos: manifestPhotos,
  };
  const manifestEnc = await encryptBytes(key, Buffer.from(JSON.stringify(manifest), 'utf8'));
  fs.writeFileSync(path.join(PHOTOS_DIR, 'manifest.bin'), manifestEnc);

  const params = {
    version: 1,
    kdf: 'PBKDF2',
    hash: 'SHA-256',
    iterations: ITERATIONS,
    saltB64: Buffer.from(salt).toString('base64'),
    cipher: 'AES-GCM',
    keyLength: 256,
    ivLength: 12,
  };
  fs.writeFileSync(path.join(PHOTOS_DIR, 'params.json'), JSON.stringify(params, null, 2) + '\n');

  console.log(`\nDone. Encrypted ${content.photos.length} photo(s) into photos/.`);
  console.log('Only photos/ (not source/) should ever be committed.');
  console.log('Re-running this script — even with the same keyword — changes every ciphertext byte');
  console.log('(fresh random salt and IVs each time). That is expected, not a bug.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
