import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

/**
 * The parts fixture the composer is exercised against: real painted pixels, not
 * mocks, because every step it runs (white keying, alpha trim, the eyewhite
 * luma split, placement) is an assertion about pixels. Shapes are the ones the
 * layout was written for — an almond eyewhite with a dark upper lash arc and a
 * lower rim, a disc iris, blobs for the rest, and a mouth that comes back
 * opaque on white the way a generator sometimes returns it.
 *
 * It lives in helpers/ rather than inside compose.test.ts so the tool-level
 * test can drive the same parts through the MCP server once compose is
 * registered as a tool.
 */

type RGB = [number, number, number];
type SetPixel = (x: number, y: number, rgb: RGB) => void;

const WHITE: RGB = [255, 255, 255];
const DARK: RGB = [20, 20, 30];
const SKIN: RGB = [240, 205, 180];
const BLUE: RGB = [40, 90, 200];
const LIP: RGB = [190, 90, 90];
const HAIR: RGB = [90, 60, 50];

/** Paint a straight-alpha RGBA canvas and write it as a PNG. */
async function writeRgbaPart(
  dir: string,
  name: string,
  width: number,
  height: number,
  paint: (set: SetPixel) => void,
): Promise<void> {
  const buf = Buffer.alloc(width * height * 4); // all transparent (alpha 0)
  const set: SetPixel = (x, y, rgb) => {
    const i = (y * width + x) * 4;
    buf[i] = rgb[0];
    buf[i + 1] = rgb[1];
    buf[i + 2] = rgb[2];
    buf[i + 3] = 255;
  };
  paint(set);
  await sharp(buf, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(path.join(dir, name));
}

/** Same, as an RGB PNG with NO alpha channel: opaque art on a white ground. */
async function writeOpaquePart(
  dir: string,
  name: string,
  width: number,
  height: number,
  paint: (set: SetPixel) => void,
): Promise<void> {
  const buf = Buffer.alloc(width * height * 3, 255); // white ground
  const set: SetPixel = (x, y, rgb) => {
    const i = (y * width + x) * 3;
    buf[i] = rgb[0];
    buf[i + 1] = rgb[1];
    buf[i + 2] = rgb[2];
  };
  paint(set);
  await sharp(buf, { raw: { width, height, channels: 3 } })
    .png()
    .toFile(path.join(dir, name));
}

/** Filled ellipse with an alpha bbox of exactly `w`x`h` centred on (cx, cy). */
function ellipse(
  set: SetPixel,
  bounds: { width: number; height: number },
  cx: number,
  cy: number,
  w: number,
  h: number,
  rgb: RGB,
): void {
  for (let y = 0; y < bounds.height; y++) {
    for (let x = 0; x < bounds.width; x++) {
      const u = (x + 0.5 - cx) / (w / 2);
      const v = (y + 0.5 - cy) / (h / 2);
      if (u * u + v * v <= 1) set(x, y, rgb);
    }
  }
}

/** The rim of that ellipse, restricted to the rows `keep` accepts. */
function rim(
  set: SetPixel,
  bounds: { width: number; height: number },
  cx: number,
  cy: number,
  w: number,
  h: number,
  thickness: number,
  keep: (y: number) => boolean,
  rgb: RGB,
): void {
  for (let y = 0; y < bounds.height; y++) {
    if (!keep(y)) continue;
    for (let x = 0; x < bounds.width; x++) {
      const u = (x + 0.5 - cx) / (w / 2);
      const v = (y + 0.5 - cy) / (h / 2);
      const inner =
        ((x + 0.5 - cx) / (w / 2 - thickness)) ** 2 +
        ((y + 0.5 - cy) / (h / 2 - thickness)) ** 2;
      if (u * u + v * v <= 1 && inner > 1) set(x, y, rgb);
    }
  }
}

/** A part that is just one ellipse on its own transparent frame. */
const blobPart =
  (
    name: string,
    width: number,
    height: number,
    w: number,
    h: number,
    rgb: RGB,
  ) =>
  (dir: string) =>
    writeRgbaPart(dir, name, width, height, (set) =>
      ellipse(set, { width, height }, width / 2, height / 2, w, h, rgb),
    );

/**
 * Every part source the layout can consume, keyed by file name. The eyewhite is
 * a white almond with a dark upper lash arc (kept by the split) and a dark lower
 * rim (dropped by it), so the two halves of prepEyeSplit are both exercised.
 */
const PARTS: Record<string, (dir: string) => Promise<void>> = {
  "hair_back.png": blobPart("hair_back.png", 120, 90, 100, 70, HAIR),
  "body.png": blobPart("body.png", 120, 80, 100, 60, DARK),
  "face.png": blobPart("face.png", 100, 120, 80, 100, SKIN),
  // The nose is a part of its own — the rig leads the head turn with it.
  "nose.png": blobPart("nose.png", 24, 34, 20, 30, DARK),
  "eyewhite.png": (dir) =>
    writeRgbaPart(dir, "eyewhite.png", 72, 48, (set) => {
      const bounds = { width: 72, height: 48 };
      ellipse(set, bounds, 36, 24, 64, 40, WHITE);
      // The split keeps dark pixels down to LASH_KEEP_FRACTION of the content
      // bbox — row 4 + 0.5*40 = 24. The two rims straddle that line with a gap
      // on either side, so which one survives is not decided by rounding.
      rim(set, bounds, 36, 24, 64, 40, 4, (y) => y < 22, DARK);
      rim(set, bounds, 36, 24, 64, 40, 3, (y) => y > 25, DARK);
    }),
  "iris.png": blobPart("iris.png", 44, 44, 36, 36, BLUE),
  "brow.png": blobPart("brow.png", 48, 20, 40, 10, DARK),
  "hair_front.png": blobPart("hair_front.png", 140, 100, 120, 80, HAIR),
  // No alpha channel: the composer must key the white ground out itself.
  "mouth.png": (dir) =>
    writeOpaquePart(dir, "mouth.png", 40, 24, (set) =>
      ellipse(set, { width: 40, height: 24 }, 20, 12, 20, 8, LIP),
    ),
  "mouth_open.png": blobPart("mouth_open.png", 40, 24, 20, 14, LIP),
};

/** Write the whole parts set into `dir`, minus any file named in `omit`. */
export async function writePartsSet(
  dir: string,
  opts: { omit?: string[] } = {},
): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const omit = new Set(opts.omit ?? []);
  for (const [name, write] of Object.entries(PARTS)) {
    if (omit.has(name)) continue;
    await write(dir);
  }
}
