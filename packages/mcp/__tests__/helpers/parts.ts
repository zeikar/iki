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
type SetPixel = (x: number, y: number, rgb: RGB, alpha?: number) => void;

const WHITE: RGB = [255, 255, 255];
const DARK: RGB = [20, 20, 30];
const SKIN: RGB = [240, 205, 180];
const BLUE: RGB = [40, 90, 200];
const LIP: RGB = [190, 90, 90];
const HAIR: RGB = [90, 60, 50];
// The light marks writeEyewhite's `crease` paints, all well over
// EYE_LASH_LUMA (luma about 197-215) and told apart by colour.
const CREASE: RGB = [215, 190, 185];
export const EYE_SHADE: RGB = [200, 205, 225];
export const EYE_MARK_BELOW: RGB = [230, 190, 200];
export const EYE_MARK_BESIDE: RGB = [240, 215, 150];
const BLUSH: RGB = [245, 160, 170];
export const BLUSH_MARK: RGB = [200, 80, 100];

/** Paint a straight-alpha RGBA canvas and write it as a PNG. */
async function writeRgbaPart(
  dir: string,
  name: string,
  width: number,
  height: number,
  paint: (set: SetPixel) => void,
): Promise<void> {
  const buf = Buffer.alloc(width * height * 4); // all transparent (alpha 0)
  const set: SetPixel = (x, y, rgb, alpha = 255) => {
    const i = (y * width + x) * 4;
    buf[i] = rgb[0];
    buf[i + 1] = rgb[1];
    buf[i + 2] = rgb[2];
    buf[i + 3] = alpha;
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

/**
 * The eyewhite: a white almond with a dark upper lash arc (kept by the split)
 * and a dark lower rim (dropped by it), so both halves of prepEyeSplit are
 * exercised. `tearDuct` leaves that end's fifth of the upper arc unlashed, the
 * way a drawn eye leaves its inner corner, which fixes the way the eye faces;
 * without it the arc is symmetric and faces neither way. `crease` adds the
 * light marks a drawn eye carries around its white, which the split must tell
 * apart. A 1-2 px double-eyelid crease arcs over the lash with transparent
 * rows between them: `"short"` over its middle, `"long"` out past both ends of
 * the white, the way a crease follows the lid past its corners, and
 * `"bridged"` the long one with a halo of its ink at alpha 24 run down to the
 * white's end, a nearly invisible antialiasing bridge, and `"translucent"`
 * that one with the crease itself painted at alpha 100, visible but under
 * the alpha 128 the split counts as painted. The marks the
 * white keeps: an EYE_SHADE band on its upper rows that touches it, an
 * EYE_MARK_BELOW dot under the lower rim, and an EYE_MARK_BESIDE dot past its
 * tear-duct end, level with the white there rather than above it.
 */
export async function writeEyewhite(
  dir: string,
  {
    tearDuct,
    crease,
  }: {
    tearDuct?: "left" | "right";
    crease?: "short" | "long" | "bridged" | "translucent";
  } = {},
): Promise<void> {
  await writeRgbaPart(dir, "eyewhite.png", 72, 48, (set) => {
    const bounds = { width: 72, height: 48 };
    ellipse(set, bounds, 36, 24, 64, 40, WHITE);
    if (crease !== undefined) {
      // Painted before the lash, which covers its outer 4 px: the band left
      // is the 4 px of white under the lash.
      rim(set, bounds, 36, 24, 64, 40, 8, (y) => y < 16, EYE_SHADE);
      if (crease === "short") {
        // The top of a taller almond, rows 0-2 over x 24..48; the eye's own
        // top is row 4 at its middle and lower either side.
        rim(set, bounds, 36, 24, 56, 48, 2, (y) => y < 3, CREASE);
      } else {
        // The top half of a flat almond as wide as the image: row 0 at the
        // middle, rows 8-9 at x 0 and 71, past the white's ends (x 4 and 67,
        // where its top is row 22).
        const alpha = crease === "translucent" ? 100 : 255;
        const setCrease: SetPixel = (x, y, rgb) => set(x, y, rgb, alpha);
        rim(setCrease, bounds, 36, 10, 72, 20, 2, (y) => y < 10, CREASE);
        // The halo: column 3 from under the crease's left end (rows 6-7
        // there) down to beside the white's (row 22 at x 4), touching both.
        if (crease === "bridged" || crease === "translucent")
          for (let y = 8; y <= 21; y++) set(3, y, CREASE, 24);
      }
      // Row 44 and column 68 stay transparent, between the dots and the eye.
      for (let y = 45; y <= 46; y++)
        for (let x = 33; x <= 38; x++) set(x, y, EYE_MARK_BELOW);
      for (let y = 22; y <= 25; y++)
        for (let x = 69; x <= 71; x++) set(x, y, EYE_MARK_BESIDE);
    }
    // The almond spans x 4..67; its end fifth is 13 px.
    const unlashed = (x: number) =>
      tearDuct === "left" ? x < 17 : tearDuct === "right" ? x > 54 : false;
    const setLash: SetPixel = (x, y, rgb) => {
      if (!unlashed(x)) set(x, y, rgb);
    };
    // The split keeps dark pixels down to LASH_KEEP_FRACTION of the content
    // bbox — row 4 + 0.5*40 = 24. The two rims straddle that line with a gap
    // on either side, so which one survives is not decided by rounding.
    rim(setLash, bounds, 36, 24, 64, 40, 4, (y) => y < 22, DARK);
    rim(set, bounds, 36, 24, 64, 40, 3, (y) => y > 25, DARK);
  });
}

/**
 * A brow.png thick at the image's left end and tapering to a point at its
 * right, where the stock brow is a symmetric blob: a part whose flip shows.
 */
export async function writeTaperedBrow(dir: string): Promise<void> {
  await writeRgbaPart(dir, "brow.png", 48, 20, (set) => {
    for (let x = 4; x < 44; x++) {
      const half = Math.round(((44 - x) / 40) * 8);
      for (let y = 10 - half; y <= 10 + half; y++) set(x, y, DARK);
    }
  });
}

/** Alpha of the soft nose's feather: visible, but under the dense core's 128. */
const SOFT_NOSE_FEATHER_ALPHA = 80;

/**
 * A nose.png drawn the way a shaded bump comes back: an opaque 20x30 core
 * inside a 36x48 feather painted at SOFT_NOSE_FEATHER_ALPHA, the core low in it
 * the way a nose's tip sits low in its shading. `{ core: false }` paints the
 * feather alone, a nose with no pixel at alpha 128. `"speck"` and `"dot"`
 * paint the feather with only an opaque nostril mark low in it, 4x3 and 1x1:
 * a dense core that is a speck of the part. `"scatter"` paints an opaque 6x6
 * mark plus two opaque 1x1 dots far apart in the feather, which stretch the
 * core to 25x31 of the part's 36x48 until a downscale blurs them away.
 */
export async function writeSoftNose(
  dir: string,
  { core = true }: { core?: boolean | "speck" | "dot" | "scatter" } = {},
): Promise<void> {
  await writeRgbaPart(dir, "nose.png", 44, 56, (set) => {
    const bounds = { width: 44, height: 56 };
    const feather: SetPixel = (x, y, rgb) =>
      set(x, y, rgb, SOFT_NOSE_FEATHER_ALPHA);
    ellipse(feather, bounds, 22, 28, 36, 48, DARK);
    if (core === true) ellipse(set, bounds, 22, 34, 20, 30, DARK);
    if (core === "speck" || core === "dot") {
      // Inside the feather's rows and columns, so the trimmed part stays the
      // feather's 36x48, which the compose tests' warning text asserts. Row
      // 43 also keeps the 1x1 dot under alpha 128 once resized to w 20 (row
      // 42 lands at 129).
      const [markW, markH] = core === "speck" ? [4, 3] : [1, 1];
      for (let y = 43; y < 43 + markH; y++)
        for (let x = 21; x < 21 + markW; x++) set(x, y, DARK);
    }
    if (core === "scatter") {
      for (let y = 38; y < 44; y++)
        for (let x = 19; x < 25; x++) set(x, y, DARK);
      set(10, 14, DARK);
      set(34, 44, DARK);
    }
  });
}

/**
 * A blush.png: a pink ellipse with a BLUSH_MARK patch inside its left end, so
 * a mirror shows. The ellipse spans x 4..43 and rows 4..19; the patch, x 6..13
 * and rows 9..14, stays inside it, so the trimmed part is the ellipse's 40x16.
 */
async function writeBlush(dir: string): Promise<void> {
  await writeRgbaPart(dir, "blush.png", 48, 24, (set) => {
    ellipse(set, { width: 48, height: 24 }, 24, 12, 40, 16, BLUSH);
    for (let y = 9; y <= 14; y++)
      for (let x = 6; x <= 13; x++) set(x, y, BLUSH_MARK);
  });
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

/** Every part source the layout can consume, keyed by file name. */
const PARTS: Record<string, (dir: string) => Promise<void>> = {
  "hair_back.png": blobPart("hair_back.png", 120, 90, 100, 70, HAIR),
  "body.png": blobPart("body.png", 120, 80, 100, 60, DARK),
  "face.png": blobPart("face.png", 100, 120, 80, 100, SKIN),
  "blush.png": writeBlush,
  // The nose is a part of its own — the rig leads the head turn with it.
  "nose.png": blobPart("nose.png", 24, 34, 20, 30, DARK),
  "eyewhite.png": (dir) => writeEyewhite(dir),
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
