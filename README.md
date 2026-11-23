# Fitly — make any image fit

Compress and resize an image to an **exact file size** and **exact dimensions**, right in the browser.
Built for the form that says *"photo must be 20–50 KB, 413×531 px"*.

No server. No uploads. No dependencies. No build step.

## Features

- **AI mode** — type what you want: `make this under 10kb, 300x400`, `passport photo`, `20kb webp`.
  A live "understood" row shows what was picked up before you hit send.
- **Manual mode** — width / height with aspect lock, max size (slider, field or quick chips), JPEG / WebP, crop or pad.
- **Fit meter** — a ring that counts the size down from the original to the result and locks in green when it fits.
- **Preset cards** — Passport photo, Signature, Profile picture, ID scan, Social share.
- Drop, click, or paste (`Ctrl+V`) an image. Before / after toggle. One-click download.
- Honest failure: if a size is physically impossible at the chosen dimensions, it tells you the smallest it can get.

## Run it

Open `index.html` in a browser. That's it.

Or serve the folder locally:

```bash
npx serve .
```

## Deploy on GitHub Pages

1. Create a new repository and push these files to the `main` branch.
2. Go to **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, select `main` and `/ (root)`, then **Save**.
4. Your site goes live at `https://<your-username>.github.io/<repo-name>/` in about a minute.

## Project structure

```
index.html   Markup
style.css    Design tokens, layout, components, animations
app.js       Prompt parser · image engine · UI
```

## How it works

- **Resize:** the image is drawn onto a canvas at the target size (`crop` fills the frame, `pad` fits inside on white).
- **Compress:** the canvas is exported as JPEG / WebP and the highest quality that stays under the limit is found by binary search.
- **Free vs. fixed dimensions:** with both width and height set, only quality changes. With one or none, pixels are also scaled down when quality alone can't reach the limit.
- **AI mode** is a lightweight, local prompt parser (regex-based). It needs no API key and nothing leaves the device.
  To upgrade it, replace `parsePrompt()` in `app.js` with a call to an LLM that returns `{ kb, width, height, type }`.

Please ⭐ if you find it useful so that I find the motivation to keep improving this. Thanks
