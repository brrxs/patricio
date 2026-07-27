# Our Album

A private photo album, meant to live on GitHub Pages and unlock with a single keyword.

## How the privacy actually works

GitHub Pages only serves static files — there's no login system behind it. A plain
"type a password to continue" popup wouldn't really protect anything, because the
photos would still be sitting in the repo in the open.

Instead, the photos in this repo are **encrypted**. The keyword you choose is used to
derive an encryption key (via PBKDF2 + AES-GCM, done in your browser using the
Web Crypto API — no external libraries, nothing sent to any server). Without the
correct keyword, everything in `photos/` is unreadable ciphertext. The keyword itself
is never written down anywhere in the repo.

**Heads up:** GitHub Pages' free tier only works from a *public* repository. That's
fine here — the repo being public just means people can see encrypted noise, not your
photos. Still, pick a real keyword (a short phrase, not a name or birthday) rather than
something guessable.

## One-time setup

1. Install [Node.js](https://nodejs.org) (LTS), then confirm it's available:
   ```
   node -v
   npm -v
   ```
2. Install dependencies:
   ```
   npm install
   ```

## Adding your photos

1. Copy your photo files into the `source/` folder (create it if it doesn't exist —
   running `npm run encrypt` once with no `source/` will scaffold it for you with
   instructions and a template).
2. Edit `source/content.json`:
   ```json
   {
     "title": "For You",
     "message": "A few of my favorite moments with you.",
     "photos": [
       { "file": "beach.jpg", "caption": "That weekend at the coast", "date": "2026-03-14" },
       { "file": "dinner.jpg", "caption": "Your birthday dinner" }
     ]
   }
   ```
   - `photos` is in the order they'll appear on the page.
   - `file` must match a filename you copied into `source/`.
   - `date` is optional — omit it if you don't want one shown.

`source/` is git-ignored — it and its contents never get committed or pushed.
Only the encrypted output in `photos/` does.

## Encrypting and generating the site content

```
npm run encrypt
```

You'll be prompted to choose a keyword (typed twice, masked so it doesn't echo to
the screen). This regenerates the entire `photos/` folder from what's currently in
`source/`.

Re-running this — even with the exact same keyword — produces completely different
encrypted bytes each time (fresh random salt and IVs). That's expected, not a bug.

## Previewing locally before you publish

Web Crypto requires a real HTTP context (plain `file://` won't work reliably), so
serve the folder locally:

```
npx serve .
```

Then open the printed `http://localhost:...` URL, enter your keyword, and confirm
the gallery unlocks, thumbnails load, and clicking a photo opens it full-size.

## Publishing

1. Commit and push everything **except** `source/` (already handled by `.gitignore`)
   to a GitHub repository.
2. In the repo's **Settings → Pages**, set the source to deploy from your default
   branch (root).
3. Wait a minute or two, then visit the Pages URL GitHub gives you.

## Sharing it

Send the link and the keyword to your boyfriend through **different channels**
(e.g. the link by text, the keyword in person or a phone call) — that way, if one
message ever leaks, the album doesn't automatically come with it.

## Updating later

Add or edit entries in `source/content.json`, drop in any new photos, run
`npm run encrypt` again, then commit and push. Everything in `photos/` is
regenerated from scratch each time — there's nothing to hand-edit there.

## Changing the keyword

Just run `npm run encrypt` again with a new keyword, then commit and push. Remember
to share the new keyword — the old one won't work anymore once you push.

## Troubleshooting

- **"Problems found in source/content.json"** — the script lists everything wrong
  (missing fields, missing files) at once; fix them all and rerun.
- **`node`/`npm` not recognized** — Node.js isn't installed or isn't on your PATH;
  reinstall from nodejs.org and restart your terminal.
- **`npm install` fails on `sharp`** — sharp ships prebuilt binaries for common
  platforms; if install fails, try a clean `npm install` again or check you're on
  a supported Node version (18+).
