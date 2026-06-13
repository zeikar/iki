// Generates the sample.psd fixture for the PSD import e2e (Task 6).
// Pure Node (ESM, no canvas) — uses ag-psd's writePsd directly.
// Each layer carries its own bounds imageData (RGBA, straight alpha) for a
// small solid rect placed at a distinct offset so the auto-rig importer has
// realistic layer geometry. No document-level canvas/imageData is set so
// writePsd never touches the canvas write path.
//
// Document spec: 8-bit RGB, 320×320, version 1 (PSD, not PSB).
// Layer layout mirrors the PNG sample set (face centred, eyes upper-L/R, mouth lower-centre).
//
// Run: node generate.mjs
import { writePsd } from "ag-psd";
import { writeFileSync } from "node:fs";

const DOC_W = 320;
const DOC_H = 320;

// Build an opaque RGBA rect of the given dimensions filled with (r,g,b).
function solidRect(w, h, r, g, b) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4 + 0] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255; // fully opaque
  }
  return data;
}

// Layer descriptors: name, left, top, width, height, fill colour (R,G,B).
// Positions are chosen so shapes are non-overlapping and look plausible as a
// character rig (face centred, eyes symmetrically above centre, mouth below).
const LAYERS = [
  // face: large skin-tone rect centred in the canvas
  { name: "face", left: 80, top: 80, w: 160, h: 160, rgb: [255, 224, 196] },
  // eye_L: character's left eye = screen right
  { name: "eye_L", left: 180, top: 110, w: 40, h: 30, rgb: [44, 92, 150] },
  // eye_R: character's right eye = screen left
  { name: "eye_R", left: 100, top: 110, w: 40, h: 30, rgb: [44, 92, 150] },
  // mouth: lower-centre
  { name: "mouth", left: 130, top: 190, w: 60, h: 25, rgb: [200, 84, 92] },
];

const children = LAYERS.map(({ name, left, top, w, h, rgb }) => ({
  name,
  left,
  top,
  // ag-psd derives bottom/right from imageData dimensions when those fields are
  // absent, but being explicit avoids any ambiguity with the writer.
  bottom: top + h,
  right: left + w,
  // imageData is the layer-bounds bitmap (w×h), NOT the full document canvas.
  imageData: {
    data: solidRect(w, h, ...rgb),
    width: w,
    height: h,
  },
}));

// colorMode 3 = RGB (matches ColorMode.RGB enum in ag-psd).
// bitsPerChannel 8 is the default but set explicitly so the header guard in
// psd-import.ts (validatePsdHeader) always finds what it expects.
const doc = {
  width: DOC_W,
  height: DOC_H,
  colorMode: 3,
  bitsPerChannel: 8,
  children,
};

const outPath = new URL("./sample.psd", import.meta.url);
const arrayBuffer = writePsd(doc);
const bytes = Buffer.from(arrayBuffer);
writeFileSync(outPath, bytes);
console.log(`wrote sample.psd (${bytes.length} bytes)`);

// Verify the 26-byte header so a broken fixture is caught immediately.
// Offsets per the PSD spec (big-endian):
//   0–3  signature ("8BPS")
//   4–5  version uint16  (1 = PSD)
//   12–13 channels uint16
//   22–23 bitsPerChannel uint16
//   24–25 colorMode uint16
const view = new DataView(arrayBuffer);
const sig = String.fromCharCode(
  view.getUint8(0),
  view.getUint8(1),
  view.getUint8(2),
  view.getUint8(3),
);
const version = view.getUint16(4, false);
const bitsPerChannel = view.getUint16(22, false);
const colorMode = view.getUint16(24, false);

console.log(
  `header: sig=${sig} version=${version} bitsPerChannel=${bitsPerChannel} colorMode=${colorMode}`,
);

if (
  sig !== "8BPS" ||
  version !== 1 ||
  bitsPerChannel !== 8 ||
  colorMode !== 3
) {
  throw new Error(
    `fixture header does not meet importer requirements: sig=${sig} version=${version} bitsPerChannel=${bitsPerChannel} colorMode=${colorMode}`,
  );
}
console.log("header OK — fixture is valid for the psd-import.ts guard");
