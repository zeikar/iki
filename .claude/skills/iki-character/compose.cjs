// Compose AI-generated part PNGs into canvas-aligned, role-named layers for the
// Iki auto-rig (`auto_rig_from_layers` MCP tool / `@iki/editor-core`
// generateIkiFromLayerSet). Each part is alpha-trimmed, resized to a target
// width, optionally mirrored, and pasted at a chosen center on a shared
// transparent canvas of CANVAS x CANVAS px.
//
// Usage:  node compose.cjs [srcDir] [outDir]
//   srcDir  directory holding the codex-image parts (default: ./parts)
//   outDir  directory to write role-named canvas layers (default: ./layers)
//
// Only dependency is `sharp`. Run from a dir where `sharp` resolves (the e2e
// installs it ad hoc, e.g. `npm i sharp` in a scratch dir), or `node --require`
// a sharp install. The composer is pure/deterministic: same parts -> same
// layers, so re-run freely after tuning LAYOUT (no image re-generation needed).
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

const CANVAS = 1000;
const SRC = path.resolve(process.argv[2] ?? "parts");
const OUT = path.resolve(process.argv[3] ?? "layers");

// ── LAYOUT (EDIT THIS per character) ──────────────────────────────────────────
// center (cx, cy) in canvas px, origin top-left, y down. w = target width px.
// These defaults assume the standard codex-image framing this skill prompts for
// (a front-facing face centered on the canvas). If the rendered model is
// misaligned, tune cx/cy/w here and re-run — composing is cheap and the parts
// do not need regenerating.
//
// eyeSide reminder: eye_L = character's LEFT eye = screen RIGHT (larger cx).
// eye_*  = clean WHITE sclera (lashes recolored white) = the blink clip mask + fold.
// iris_* = colored disc on top, clipped to the sclera, drives gaze.
// lash_* = the dark lashes, a separate layer ABOVE the iris that folds down to
//          cover the closed-eye seam. eye_* and lash_* are split from a single
//          `eyewhite.png` (white almond + dark lashes) by prepEyeSplit().
const LAYOUT = {
  face: { src: "face.png", cx: 500, cy: 470, w: 600 },
  mouth: { src: "mouth.png", cx: 500, cy: 612, w: 150 },
  // eye_* (sclera) and lash_* share the eyewhite's cropped frame via noTrim (so
  // they are NOT re-bboxed independently): the upper lash stays anchored ABOVE
  // the sclera center, so on blink it folds DOWN over the eye like the sample
  // model instead of the whole eye shrinking in place. Same cx/cy/w.
  eye_L: { src: "eyewhite_sclera.png", cx: 590, cy: 468, w: 150, noTrim: true },
  eye_R: { src: "eyewhite_sclera.png", cx: 410, cy: 468, w: 150, mirror: true, noTrim: true }, // prettier-ignore
  iris_L: { src: "iris.png", cx: 590, cy: 470, w: 48, mirror: false },
  iris_R: { src: "iris.png", cx: 410, cy: 470, w: 48, mirror: true },
  lash_L: { src: "eyewhite_lash.png", cx: 590, cy: 468, w: 150, noTrim: true },
  lash_R: { src: "eyewhite_lash.png", cx: 410, cy: 468, w: 150, mirror: true, noTrim: true }, // prettier-ignore
  brow_L: { src: "brow.png", cx: 590, cy: 378, w: 138, mirror: false },
  brow_R: { src: "brow.png", cx: 410, cy: 378, w: 138, mirror: true },
  hair_front: { src: "hair_front.png", cx: 500, cy: 330, w: 660 },
};

// Draw order (back -> front), mirrors @iki/editor-core ROLE_TABLE order.
const ORDER = [
  "face",
  "mouth",
  "eye_L",
  "eye_R",
  "iris_L",
  "iris_R",
  "lash_L",
  "lash_R",
  "brow_L",
  "brow_R",
  "hair_front",
];

// The eyewhite source that prepEyeSplit() splits into sclera + lash.
const EYEWHITE_SRC = "eyewhite.png";
// Luminance below this (0..255) = a dark lash/outline pixel in the eyewhite.
const EYE_LASH_LUMA = 120;
// Of the eye's dark pixels, keep only those in the TOP this-fraction as the lash
// (drops the lower almond rim/outline) so the lash reads as an upper arc that
// folds DOWN over the eye on blink, instead of a full ring that shrinks in place.
const LASH_KEEP_FRACTION = 0.5;

// Some generated parts come back opaque on a white background (no alpha).
// Key near-white pixels to transparent so they can layer cleanly.
async function keyWhiteToAlpha(srcPath) {
  const { data, info } = await sharp(srcPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  for (let i = 0; i < data.length; i += ch) {
    if (data[i] > 238 && data[i + 1] > 238 && data[i + 2] > 238) {
      data[i + 3] = 0;
    }
  }
  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: ch },
  })
    .png()
    .toBuffer();
}

async function partBuffer(cfg) {
  const srcPath = path.join(SRC, cfg.src);
  if (!fs.existsSync(srcPath)) {
    throw new Error(
      `missing part source: ${srcPath} (role expects "${cfg.src}")`,
    );
  }
  const meta0 = await sharp(srcPath).metadata();
  const input = meta0.hasAlpha ? srcPath : await keyWhiteToAlpha(srcPath);
  // noTrim parts (the eye pair) keep their shared pre-cropped frame so sclera and
  // lash stay aligned; everything else is alpha-trimmed to its own bbox.
  let img = sharp(input);
  if (!cfg.noTrim) img = img.trim({ threshold: 12 });
  if (cfg.mirror) img = img.flop();
  const buf = await img.resize({ width: cfg.w }).png().toBuffer();
  const meta = await sharp(buf).metadata();
  return { buf, w: meta.width, h: meta.height };
}

function placement(cfg, w, h) {
  return { left: Math.round(cfg.cx - w / 2), top: Math.round(cfg.cy - h / 2) };
}

function blankCanvas() {
  return sharp({
    create: {
      width: CANVAS,
      height: CANVAS,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });
}

// Split eyewhite.png (white almond + dark lashes) into a clean white sclera
// (the dark outline/lash recolored to white = the blink clip-mask shape) and a
// dark UPPER-lash-only layer. Both are cropped to the SAME eye bbox so they stay
// aligned (consumed with noTrim): the lash arc keeps its position at the top of
// the sclera, so on blink it folds DOWN over the eye rather than the eye shrinking
// in place. Writes eyewhite_sclera.png + eyewhite_lash.png into SRC for LAYOUT.
async function prepEyeSplit() {
  const srcPath = path.join(SRC, EYEWHITE_SRC);
  if (!fs.existsSync(srcPath)) {
    throw new Error(`missing eyewhite source: ${srcPath}`);
  }
  const { data, info } = await sharp(srcPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const W = info.width;
  const H = info.height;

  // Eye content bbox (alpha) → the shared cropped frame for both outputs.
  let minX = W;
  let minY = H;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * ch + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error("eyewhite is fully transparent");
  // Keep only the upper lash: dark pixels above this row become the lash layer.
  const lashCutoffY = minY + LASH_KEEP_FRACTION * (maxY - minY + 1);

  const sclera = Buffer.from(data);
  const lash = Buffer.from(data);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * ch;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const isDark = data[i + 3] > 0 && lum < EYE_LASH_LUMA;
      if (isDark) sclera[i] = sclera[i + 1] = sclera[i + 2] = 255; // dark -> white
      if (!(isDark && y <= lashCutoffY)) lash[i + 3] = 0; // keep upper dark only
    }
  }
  const raw = { width: W, height: H, channels: ch };
  const region = {
    left: minX,
    top: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
  await sharp(sclera, { raw })
    .extract(region)
    .png()
    .toFile(path.join(SRC, "eyewhite_sclera.png"));
  await sharp(lash, { raw })
    .extract(region)
    .png()
    .toFile(path.join(SRC, "eyewhite_lash.png"));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await prepEyeSplit();
  const preview = [];
  for (const role of ORDER) {
    const cfg = LAYOUT[role];
    const { buf, w, h } = await partBuffer(cfg);
    const { left, top } = placement(cfg, w, h);
    // role layer: this part alone on a full canvas at its position.
    await blankCanvas()
      .composite([{ input: buf, left, top }])
      .png()
      .toFile(path.join(OUT, role + ".png"));
    preview.push({ input: buf, left, top });
    console.log(`${role}: ${w}x${h} @ (${left},${top})`);
  }
  // Flattened preview over a light bg so transparency reads clearly.
  await sharp({
    create: {
      width: CANVAS,
      height: CANVAS,
      channels: 4,
      background: { r: 245, g: 245, b: 248, alpha: 1 },
    },
  })
    .composite(preview)
    .png()
    .toFile(path.join(OUT, "preview.png"));
  console.log("wrote", OUT, "(role layers + preview.png)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
