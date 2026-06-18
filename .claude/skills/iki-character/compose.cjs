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
  eye_L: {
    src: "eyewhite_sclera.png",
    cx: 590,
    cy: 468,
    w: 150,
    mirror: false,
  },
  eye_R: { src: "eyewhite_sclera.png", cx: 410, cy: 468, w: 150, mirror: true },
  iris_L: { src: "iris.png", cx: 590, cy: 470, w: 48, mirror: false },
  iris_R: { src: "iris.png", cx: 410, cy: 470, w: 48, mirror: true },
  lash_L: { src: "eyewhite_lash.png", cx: 590, cy: 468, w: 150, mirror: false },
  lash_R: { src: "eyewhite_lash.png", cx: 410, cy: 468, w: 150, mirror: true },
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
  let img = sharp(input).trim({ threshold: 12 });
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
// (lashes recolored to white = the blink clip-mask shape) and a dark lash-only
// layer. Keeps the lash texture matched to the eye and avoids doubling the lash.
// Writes eyewhite_sclera.png + eyewhite_lash.png into SRC for LAYOUT to consume.
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
  const sclera = Buffer.from(data);
  const lash = Buffer.from(data);
  const THRESH = 120; // luminance below this = dark lash pixel
  for (let i = 0; i < data.length; i += ch) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const isLash = data[i + 3] > 0 && lum < THRESH;
    if (isLash) {
      sclera[i] = sclera[i + 1] = sclera[i + 2] = 255; // dark lash -> white
    } else {
      lash[i + 3] = 0; // non-lash -> transparent in the lash layer
    }
  }
  const raw = { width: info.width, height: info.height, channels: ch };
  await sharp(sclera, { raw })
    .png()
    .toFile(path.join(SRC, "eyewhite_sclera.png"));
  await sharp(lash, { raw }).png().toFile(path.join(SRC, "eyewhite_lash.png"));
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
