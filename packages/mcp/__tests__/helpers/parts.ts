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
export const SKIN: RGB = [240, 205, 180];
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
export const SLEEVE: RGB = [70, 80, 160];
export const ARM_MARK: RGB = [60, 160, 90];

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
    lowerLid = true,
    faintLowerSpeck = false,
  }: {
    tearDuct?: "left" | "right";
    crease?: "short" | "long" | "bridged" | "translucent";
    /** Leave it out for a white with no dark lower lid. */
    lowerLid?: boolean;
    /** Dark residue under alpha 8 below the white, inside its frame. */
    faintLowerSpeck?: boolean;
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
    if (lowerLid) rim(set, bounds, 36, 24, 64, 40, 3, (y) => y > 25, DARK);
    // The frame's lower-left corner, outside the almond.
    if (faintLowerSpeck)
      for (let y = 40; y <= 43; y++)
        for (let x = 5; x <= 8; x++) set(x, y, DARK, 4);
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
 * A body.png that is the stock body's ellipse (x 10..109, rows 10..69, painted
 * at `bodyAlpha`) plus a 3x6 mark at `markAlpha` in x 1..3, rows 30..35:
 * detached from the ellipse by six transparent columns, so the trimmed part
 * runs 109 wide from the mark instead of the ellipse's 100.
 */
export async function writeBodyWithMark(
  dir: string,
  { markAlpha, bodyAlpha = 255 }: { markAlpha: number; bodyAlpha?: number },
): Promise<void> {
  await writeRgbaPart(dir, "body.png", 120, 80, (set) => {
    ellipse(
      (x, y, rgb) => set(x, y, rgb, bodyAlpha),
      { width: 120, height: 80 },
      60,
      40,
      100,
      60,
      DARK,
    );
    for (let y = 30; y < 36; y++)
      for (let x = 1; x < 4; x++) set(x, y, DARK, markAlpha);
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

export const CAVITY: RGB = [90, 30, 40];
export const TONGUE: RGB = [230, 120, 130];
export const TEETH: RGB = [250, 248, 245];
export const LIP_RIM: RGB = [245, 190, 160];
export const KEY_GREEN: RGB = [0, 255, 0];

/**
 * A mouth_keyed.png, 120x60: a DARK outline ring round a 96x36 elliptical
 * hole filled KEY_GREEN (the ring 6 px thick along its top, the upper line,
 * and 3 px elsewhere), a DARK 8x3 hook stroke past each end of the ring, and a
 * SKIN crescent 10 rows deep under the ring's lower half (the lower lip).
 * `broken` cuts a 6 px slit through the ring and the lip at the bottom, so
 * the green reaches the outside; `noGreen` leaves the hole transparent;
 * `twoRegions` lays a TEETH bar across the hole's middle, parting the green
 * in two; `spill` puts a 10x10 block of KEY_GREEN on the lip's skin (about
 * 4 % of the hole).
 */
export async function writeKeyedMouth(
  dir: string,
  opts: {
    broken?: boolean;
    noGreen?: boolean;
    twoRegions?: boolean;
    spill?: boolean;
  } = {},
): Promise<void> {
  const [cx, cy, rx, ry] = [60, 28, 48, 18];
  const ring = (x: number, y: number, up: number) =>
    ((x + 0.5 - cx) / (rx + 3)) ** 2 + ((y + 0.5 + up - cy) / (ry + 3)) ** 2 <=
    1;
  const hole = (x: number, y: number) =>
    ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1;
  await writeRgbaPart(dir, "mouth_keyed.png", 120, 60, (set) => {
    for (let y = 0; y < 60; y++) {
      for (let x = 0; x < 120; x++) {
        const lower =
          y + 0.5 > cy &&
          ((x + 0.5 - cx) / (rx + 3)) ** 2 +
            ((y + 0.5 - cy) / (ry + 13)) ** 2 <=
            1;
        const line = ring(x, y, 0) || (y + 0.5 < cy && ring(x, y, 3));
        if (hole(x, y)) {
          if (!opts.noGreen) set(x, y, KEY_GREEN);
        } else if (line) {
          set(x, y, DARK);
        } else if (lower) {
          set(x, y, SKIN);
        }
        if (
          opts.twoRegions &&
          y >= cy - 3 &&
          y < cy + 3 &&
          (hole(x, y) || line)
        )
          set(x, y, TEETH);
        if (opts.spill && x >= 55 && x < 65 && y >= 49 && y < 59)
          set(x, y, KEY_GREEN);
        const hook =
          y >= cy - 1 &&
          y <= cy + 1 &&
          ((x >= 1 && x <= 8) || (x >= 111 && x <= 118));
        if (hook) set(x, y, DARK);
      }
    }
    if (opts.broken) {
      for (let y = cy + 10; y < 60; y++)
        for (let x = 57; x < 63; x++) set(x, y, DARK, 0);
    }
  });
}

/**
 * A mouth_interior.png, 100x50: a CAVITY oval filling the image, a TEETH band
 * 8 rows deep along its top, a TONGUE half-ellipse at its bottom and, with
 * `rim` (the default), a LIP_RIM band 6 rows deep along the bottom edge that
 * touches the border, the way a generator draws a lip under the cavity.
 * `allRim` paints the whole oval LIP_RIM.
 */
export async function writeInterior(
  dir: string,
  opts: { rim?: boolean; allRim?: boolean } = {},
): Promise<void> {
  const inOval = (x: number, y: number) =>
    ((x + 0.5 - 50) / 50) ** 2 + ((y + 0.5 - 25) / 25) ** 2 <= 1;
  await writeRgbaPart(dir, "mouth_interior.png", 100, 50, (set) => {
    for (let y = 0; y < 50; y++) {
      for (let x = 0; x < 100; x++) {
        if (!inOval(x, y)) continue;
        let rgb = CAVITY;
        if (y < 8) rgb = TEETH;
        else if (
          y >= 38 &&
          ((x + 0.5 - 50) / 22) ** 2 + ((y + 0.5 - 38) / 10) ** 2 <= 1
        )
          rgb = TONGUE;
        if (opts.allRim || ((opts.rim ?? true) && y >= 44)) rgb = LIP_RIM;
        set(x, y, rgb);
      }
    }
  });
}

/** The parts set with the lip set's two sources in place of the legacy mouth. */
export async function writeLipParts(
  dir: string,
  opts: {
    keyed?: Parameters<typeof writeKeyedMouth>[1];
    interior?: Parameters<typeof writeInterior>[1];
  } = {},
): Promise<void> {
  await writePartsSet(dir, { omit: ["mouth.png", "mouth_open.png"] });
  await writeKeyedMouth(dir, opts.keyed);
  await writeInterior(dir, opts.interior);
}

/**
 * A body.png drawn neck to feet, 200x600: a 30 px neck on rows 0..39, so its
 * top edge is mostly clear; a 160 px torso on rows 40..299 whose shoulders
 * are squared with 20 px rounded corners, so its straight sides cover rows
 * 60..299, under half the crop's height; and two 66 px legs from the crotch
 * at row 300 (0.5 of the height) down, with an 8 px gap between them.
 */
async function writeFullBody(dir: string): Promise<void> {
  await writeRgbaPart(dir, "body.png", 200, 600, (set) => {
    for (let y = 0; y < 40; y++) for (let x = 85; x < 115; x++) set(x, y, DARK);
    const r = 20;
    for (let y = 40; y < 300; y++) {
      for (let x = 20; x < 180; x++) {
        // Distance past the nearer top corner's centre, 0 off the corners.
        const dx = Math.max(0, 20 + r - (x + 0.5), x + 0.5 - (180 - r));
        const dy = Math.max(0, 40 + r - (y + 0.5));
        if (dx * dx + dy * dy <= r * r) set(x, y, DARK);
      }
    }
    for (let y = 300; y < 600; y++) {
      for (let x = 30; x < 96; x++) set(x, y, DARK);
      for (let x = 104; x < 170; x++) set(x, y, DARK);
    }
  });
}

/**
 * An arm.png. `"hanging"`: an upright 40x240 ellipse (about 1:6) with a
 * 28x40 hand at its lower left, as an arm hangs slanting a little left to
 * its hand, so its shoulder lies right of its crop's centre, 48x260; and an
 * ARM_MARK patch inside the ellipse's left half, so a mirror shows.
 * `"squat"`: a 120x40 ellipse, wider than tall — an arm too short for the
 * rig to put an elbow under its shoulder — with the same patch.
 */
async function writeArm(dir: string, arm: "hanging" | "squat"): Promise<void> {
  const [width, height] = arm === "hanging" ? [64, 268] : [128, 48];
  await writeRgbaPart(dir, "arm.png", width, height, (set) => {
    const bounds = { width, height };
    if (arm === "hanging") {
      // x 20..59, rows 4..243; the hand x 12..39, rows 224..263.
      ellipse(set, bounds, 40, 124, 40, 240, SLEEVE);
      ellipse(set, bounds, 26, 244, 28, 40, SKIN);
    } else {
      ellipse(set, bounds, 64, 24, 120, 40, SLEEVE);
    }
    const [x0, y0] = arm === "hanging" ? [26, 120] : [30, 20];
    for (let y = y0; y < y0 + 8; y++)
      for (let x = x0; x < x0 + 8; x++) set(x, y, ARM_MARK);
  });
}

/**
 * A forearm_pose.png, 56x150: the forearm raised, an upright 40x100 sleeve
 * ellipse with a 36x50 skin hand on top, rounded and closed at its bottom
 * (elbow) end, and an ARM_MARK patch inside the sleeve's left half, so a
 * mirror shows. Scaled to the hanging arm's elbow run it reaches about as
 * far up from the elbow as the hanging arm does down.
 */
async function writeForearmPose(dir: string): Promise<void> {
  const bounds = { width: 56, height: 150 };
  await writeRgbaPart(dir, "forearm_pose.png", 56, 150, (set) => {
    ellipse(set, bounds, 28, 100, 40, 100, SLEEVE);
    ellipse(set, bounds, 28, 30, 36, 50, SKIN);
    for (let y = 95; y < 103; y++)
      for (let x = 16; x < 24; x++) set(x, y, ARM_MARK);
  });
}

/**
 * The parts set with a full body for the stock torso, plus one arm.png
 * (`"hanging"` unless `arm` says otherwise), and with `pose` one
 * forearm_pose.png.
 */
export async function writeFullBodyParts(
  dir: string,
  {
    arm = "hanging",
    pose = false,
  }: { arm?: "hanging" | "squat"; pose?: boolean } = {},
): Promise<void> {
  await writePartsSet(dir, { omit: ["body.png"] });
  await writeFullBody(dir);
  await writeArm(dir, arm);
  if (pose) await writeForearmPose(dir);
}
