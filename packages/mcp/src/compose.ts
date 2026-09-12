/**
 * Compose AI-generated part PNGs into canvas-aligned, role-named layers for the
 * Iki auto-rig (`auto_rig_from_layers` / `@ikijs/editor` generateIkiFromLayerSet).
 * Each part is alpha-trimmed, resized to a target width, optionally mirrored,
 * and pasted at a chosen center on a shared transparent CANVAS x CANVAS canvas.
 *
 * Ports the composer that shipped as a script in the Claude Code plugin, so a
 * plugin user gets it from the MCP server instead of an ad-hoc `sharp` install.
 * Composing is deterministic: same parts -> same layers, so re-run freely after
 * tuning `layout` (no image re-generation needed).
 *
 * `sharp` must stay confined to @ikijs/mcp; part decoding goes through
 * ./node-images, this package's single image-decode boundary.
 */

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { cropToBuffer, decodePng } from "./node-images";
import { measureDir, type MeasureReport } from "./measure";
import {
  AutoRigInputError,
  resolveInputDir,
  resolveOutputDir,
  writeFileAtomic,
} from "./limits";

/**
 * Side of the square layer canvas, in px. NOT an input: the layout defaults
 * below place parts against this size (hair_front alone is 660px wide, and
 * sharp rejects a composite input larger than its destination), so a different
 * canvas would need its own layout. The tuning surface is `layout` overrides.
 */
export const CANVAS = 1100;

// Iris width as a fraction of the sclera width. Anime irises fill most of the
// eye opening and are clipped by the lids — the auto-rig clips iris->sclera at
// runtime, so a large iris cannot spill. The first sample's 32% iris read as a
// bead floating in white, so the defaults below use 56.25% (72px in a 128px
// opening) to reduce excess white below the iris. A caller retunes eye size
// through `layout.eye_L/eye_R.w` and MUST move `layout.iris_L/iris_R.w` with it
// to keep that ratio.
const EYE_W = 128;
const IRIS_W = Math.round(EYE_W * 0.5625);

/** The eyewhite source that prepEyeSplit() splits into sclera + lash. */
const EYEWHITE_SRC = "eyewhite.png";
/** Luminance below this (0..255) = a dark lash/outline pixel in the eyewhite. */
const EYE_LASH_LUMA = 120;
// Of the eye's dark pixels, keep only those in the TOP this-fraction as the lash
// (drops the lower almond rim/outline) so the lash reads as an upper arc that
// folds DOWN over the eye on blink, instead of a full ring that shrinks in place.
const LASH_KEEP_FRACTION = 0.5;

// ── Nose cut ──────────────────────────────────────────────────────────────────
// The auto-rig gives the nose more head-turn travel than the eyes and mouth —
// on a real head it stands furthest off the face, so it leads them toward the
// far side and the far eye ends up crowding it. The generator draws it INTO
// face.png, though, and a nose that stays on the face plate while the eyes and
// mouth slide past it reads worse than no parallax at all: a blind review
// ranked that rig below the static one, the nose ending up nearer the NEAR eye.
// So the composer cuts it out. Within the gap between the eyes, from the eye
// line down to the mouth, every pixel that is not the face's skin colour is
// nose (line art and shadow); those pixels become nose.png and the face gets
// skin filled in behind them. Composited back at rest they are the original.

/** Max-channel distance from the box's median skin beyond which a pixel is
 *  nose. On a real face the skin sat at 0–8, the nose shadow at 32–48 and the
 *  line art further out; 20 splits them with room for shading noise. */
const NOSE_INK_TOL = 20;
/** The weaker distance at which a pixel TOUCHING the ink still counts as nose
 *  (the bridge highlight, the shadow's soft edge) — above the skin's own
 *  noise, which sat at 0–8. */
const NOSE_INK_LOW = 8;
/** Pixels the cut grows past the detected ink, so the shadow's soft halo comes
 *  along instead of staying on the face as a ghost. */
const NOSE_GROW = 2;
/** Fewer ink pixels than this and the face has no drawn nose: no layer. Low
 *  on purpose: the hero's nose is a 15-pixel dot, and a dot that leads the
 *  turn still carries the cue. */
const NOSE_MIN_PIXELS = 12;
/** A cut over more than this share of the window's opaque pixels is not a
 *  nose (a real one is 3–6% once grown; a nose-free face shaded across the
 *  window grew to 60–70%). Measured on the GROWN cut: a handful of seeds at
 *  the ends of a gradient grow across the whole of it. */
const NOSE_MAX_CUT_FRACTION = 0.25;
/** A row with fewer opaque pixels than this takes the window's median as its
 *  skin instead of its own. */
const NOSE_ROW_MIN_PIXELS = 8;
/** How far past the cut, in px, the fill looks for a skin-coloured endpoint
 *  before falling back to the row's median. */
const NOSE_FILL_REACH = 8;

interface RoleLayout {
  /** Part file name in the parts dir (the eye pair's two are split in memory). */
  src: string;
  /** Center in canvas px, origin top-left, y down. */
  cx: number;
  cy: number;
  /** Target width in px. */
  w: number;
  /**
   * Target height in px. Omitted, the height follows the part's own aspect
   * ratio — which is the right default for every role whose drawing already has
   * the proportions it should. It exists for the one that does not: an eyewhite
   * comes back flatter than the reference often enough that three generations
   * asking for "taller" landed at 0.47, while stretching a flat white lens ~15%
   * is invisible and free. Set it on the sclera and its lash together or the
   * fold tears — they share one frame.
   */
  h?: number;
  optional?: boolean;
  mirror?: boolean;
  noTrim?: boolean;
}

// ── DEFAULT LAYOUT (tune per character through `layout`) ──────────────────────
// These defaults assume the standard framing the character skill prompts for
// (a front-facing face centered on the canvas). If the rendered model is
// misaligned, tune cx/cy/w through the `layout` override and re-run — composing
// is cheap and the parts do not need regenerating.
//
// eyeSide reminder: eye_L = character's LEFT eye = screen RIGHT (larger cx).
// eye_*  = clean WHITE sclera (lashes recolored white) = the blink clip mask + fold.
// iris_* = colored disc on top, clipped to the sclera, drives gaze.
// lash_* = the dark lashes, a separate layer ABOVE the iris that folds down to
//          cover the closed-eye seam. eye_* and lash_* are split from a single
//          `eyewhite.png` (white almond + dark lashes) by prepEyeSplit().
const DEFAULT_LAYOUT = {
  // Back hair and body sit behind the face. Both are OPTIONAL: a parts dir
  // without them still composes (head-only character).
  hair_back: { src: "hair_back.png", cx: 550, cy: 523, w: 800, optional: true },
  // The torso, cut off by the canvas bottom. It rides its own `bodyDeformer`: a
  // light share of the head turn and half its breath bob, so the character is
  // not a floating head.
  body: { src: "body.png", cx: 550, cy: 1017, w: 840, optional: true },
  face: { src: "face.png", cx: 550, cy: 475, w: 400 },
  mouth: { src: "mouth.png", cx: 550, cy: 619, w: 68 },
  // Cross-fades with `mouth` on ParamMouthOpenY (opacity, not scaleY) once the
  // auto-rig sees both roles. Same cx/w as `mouth` so the lip width matches;
  // its top edge (not center) lines up with the closed mouth's top edge since
  // the mouth opens downward from a fixed upper lip — hence the +2 cy nudge
  // rather than sharing cy outright. Optional: composes fine without it.
  mouth_open: {
    src: "mouth_open.png",
    cx: 550,
    cy: 621,
    w: 68,
    optional: true,
  },
  // eye_* (sclera) and lash_* share the eyewhite's cropped frame via noTrim (so
  // they are NOT re-bboxed independently): the upper lash stays anchored ABOVE
  // the sclera center, so on blink it folds DOWN over the eye like the sample
  // model instead of the whole eye shrinking in place. Same cx/cy/w.
  eye_L: { src: "eyewhite_sclera.png", cx: 657, cy: 475, w: EYE_W, mirror: true, noTrim: true }, // prettier-ignore
  eye_R: { src: "eyewhite_sclera.png", cx: 443, cy: 475, w: EYE_W, mirror: false, noTrim: true }, // prettier-ignore
  iris_L: { src: "iris.png", cx: 653, cy: 475, w: IRIS_W, mirror: false },
  iris_R: { src: "iris.png", cx: 447, cy: 475, w: IRIS_W, mirror: false },
  lash_L: {
    src: "eyewhite_lash.png",
    cx: 657,
    cy: 475,
    w: EYE_W,
    mirror: true,
    noTrim: true,
  },
  lash_R: { src: "eyewhite_lash.png", cx: 443, cy: 475, w: EYE_W, mirror: false, noTrim: true }, // prettier-ignore
  brow_L: { src: "brow.png", cx: 645, cy: 405, w: 135, mirror: false },
  brow_R: { src: "brow.png", cx: 455, cy: 405, w: 135, mirror: true },
  hair_front: { src: "hair_front.png", cx: 550, cy: 425, w: 660 },
} satisfies Record<string, RoleLayout>;

export type Role = keyof typeof DEFAULT_LAYOUT;
/** A written layer's role: a placed part, or the nose cut out of the face. */
export type LayerRole = Role | "nose";

/** Draw order (back -> front), mirrors @ikijs/editor ROLE_TABLE order. */
const ORDER: Role[] = [
  "hair_back",
  "body",
  "face",
  "mouth",
  "mouth_open",
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

/** Per-role placement overrides; anything omitted keeps the default above. */
export type LayoutOverride = Partial<
  Record<Role, { cx?: number; cy?: number; w?: number; h?: number }>
>;

export interface ComposeInput {
  /** Directory of the generated part PNGs (relative paths resolve against cwd). */
  partsDir: string;
  /**
   * Existing directory under cwd to write the role layers into. Callers reuse
   * one across runs (it must pre-exist), so the compose leaves it holding
   * exactly the roles it reports: a skipped role's layer from an earlier run is
   * removed rather than left for the next tool to pick up.
   */
  outDir: string;
  layout?: LayoutOverride;
}

export interface ComposedLayer {
  role: LayerRole;
  path: string;
  /** Size of the placed part itself (the file is always CANVAS x CANVAS). */
  width: number;
  height: number;
  left: number;
  top: number;
}

export type ComposeResult =
  | {
      ok: true;
      outDir: string;
      layers: ComposedLayer[];
      /** Roles whose optional part was absent from the parts dir — and `nose`
       *  when the face had no drawn nose to cut. */
      skipped: LayerRole[];
      preview: string;
      measure: MeasureReport;
    }
  | { ok: false; error: string };

/**
 * Merge caller overrides onto the defaults. Input boundary: an unknown role, a
 * non-finite centre or an out-of-range width fails fast, path-qualified, before
 * any decode. `w` is capped at CANVAS so a resized part can never exceed the
 * canvas width; `cx`/`cy` are unbounded here because a part may legitimately
 * hang off an edge — placement() rejects the one that lands nowhere on it.
 */
function resolveLayout(
  overrides: LayoutOverride | undefined,
): Record<Role, RoleLayout> {
  const resolved: Record<Role, RoleLayout> = { ...DEFAULT_LAYOUT };
  if (overrides === undefined) return resolved;
  for (const [role, override] of Object.entries(overrides)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_LAYOUT, role)) {
      throw new AutoRigInputError(
        `layout.${role}: unknown role — expected one of ${Object.keys(DEFAULT_LAYOUT).join(", ")}`,
      );
    }
    if (override === undefined) continue;
    const next = { ...resolved[role as Role] };
    for (const field of ["cx", "cy"] as const) {
      const value = override[field];
      if (value === undefined) continue;
      if (!Number.isFinite(value)) {
        throw new AutoRigInputError(
          `layout.${role}.${field} must be a finite number, got ${String(value)}`,
        );
      }
      next[field] = value;
    }
    for (const field of ["w", "h"] as const) {
      const value = override[field];
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < 1 || value > CANVAS) {
        throw new AutoRigInputError(
          `layout.${role}.${field} must be an integer in 1..${CANVAS}, got ${String(value)}`,
        );
      }
      next[field] = value;
    }
    resolved[role as Role] = next;
  }
  return resolved;
}

/**
 * Some generated parts come back opaque on a white background (no alpha).
 * Key near-white pixels to transparent so they can layer cleanly.
 */
function keyWhiteToAlpha(rgba: Buffer): Buffer {
  const keyed = Buffer.from(rgba);
  for (let i = 0; i < keyed.length; i += 4) {
    if (keyed[i] > 238 && keyed[i + 1] > 238 && keyed[i + 2] > 238) {
      keyed[i + 3] = 0;
    }
  }
  return keyed;
}

/**
 * Trim/mirror a part and resize it to its layout width. `inMemory` carries the
 * eye pair's two split buffers; every other role is read from the parts dir.
 * Missing optional part -> null; missing required part -> AutoRigInputError.
 */
async function partBuffer(
  role: Role,
  cfg: RoleLayout,
  partsDir: string,
  inMemory: Buffer | undefined,
): Promise<{ buf: Buffer; w: number; h: number } | null> {
  let img: sharp.Sharp;
  if (inMemory !== undefined) {
    img = sharp(inMemory);
  } else {
    const srcPath = path.join(partsDir, cfg.src);
    if (!fs.existsSync(srcPath)) {
      // Optional roles (hair_back, body, mouth_open) are absent from a
      // head-only parts dir; the auto-rig only requires face/eye_L/eye_R/mouth.
      if (cfg.optional) return null;
      // Name the role, not just the file: one source feeds two roles
      // (brow.png -> brow_L/brow_R), so the path alone does not say what broke.
      throw new AutoRigInputError(
        `missing part source for role "${role}": ${srcPath}`,
      );
    }
    const png = await decodePng(srcPath);
    // decodePng is the package's decode boundary: it caps the source at
    // MAX_INPUT_PIXELS and reports a bad/corrupt file as a path-qualified
    // AutoRigInputError, so the raw re-wrap below is already bounded.
    img = sharp(png.hasAlpha ? png.rgba : keyWhiteToAlpha(png.rgba), {
      raw: { width: png.width, height: png.height, channels: 4 },
    });
  }
  // noTrim parts (the eye and lash pairs) keep their shared pre-cropped frame so
  // sclera and lash stay aligned; everything else is alpha-trimmed to its own bbox.
  if (!cfg.noTrim) img = img.trim({ threshold: 12 });
  if (cfg.mirror) img = img.flop();
  // Materialise the trimmed part BEFORE resizing: its size is bounded by the
  // source decode limit, so the height the resize WOULD produce can be checked
  // against the canvas while only the bounded buffer is allocated.
  const trimmed = await img.png().toBuffer({ resolveWithObject: true });
  // An explicit h is already bounded by resolveLayout; only the aspect-derived
  // height can run past the canvas.
  if (cfg.h === undefined) {
    const scaledH = Math.round(
      (trimmed.info.height * cfg.w) / trimmed.info.width,
    );
    if (scaledH > CANVAS) {
      throw new AutoRigInputError(
        `layout.${role}.w: resized part ${cfg.w}x${scaledH} exceeds the ${CANVAS} canvas`,
      );
    }
  }
  const resized = await sharp(trimmed.data)
    // Width alone keeps the source aspect. With h, fit:"fill" is the point —
    // stretch to the given box instead. Both options stay off the width-only
    // path: passing height:undefined alongside fit:"fill" makes sharp drop the
    // aspect it would otherwise preserve.
    .resize(
      cfg.h === undefined
        ? { width: cfg.w }
        : { width: cfg.w, height: cfg.h, fit: "fill" },
    )
    .png()
    .toBuffer({ resolveWithObject: true });
  return {
    buf: resized.data,
    w: resized.info.width,
    h: resized.info.height,
  };
}

/**
 * Where the part lands, centred on its layout cx/cy. Running off an edge is
 * legitimate — `body` is meant to be cut off by the canvas bottom — so the test
 * is INTERSECTION, not containment. A part that misses the canvas entirely
 * composes to a fully transparent layer that nothing downstream flags
 * (measureDir warns per measured layer, and an empty one has no geometry), so a
 * sign-flipped centre would otherwise read as success.
 */
function placement(role: Role, cfg: RoleLayout, w: number, h: number) {
  const left = Math.round(cfg.cx - w / 2);
  const top = Math.round(cfg.cy - h / 2);
  if (left + w <= 0 || top + h <= 0 || left >= CANVAS || top >= CANVAS) {
    throw new AutoRigInputError(
      `layout.${role}.cx/cy: the placed part (${w}x${h} at ${left},${top}) falls entirely outside the ${CANVAS} canvas`,
    );
  }
  return { left, top };
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

/**
 * Split eyewhite.png (white almond + dark lashes) into a clean white sclera
 * (the dark outline/lash recolored to white = the blink clip-mask shape) and a
 * dark UPPER-lash-only layer. Both are cropped to the SAME eye bbox so they stay
 * aligned (consumed with noTrim): the lash arc keeps its position at the top of
 * the sclera, so on blink it folds DOWN over the eye rather than the eye shrinking
 * in place.
 *
 * Both come back as PNG buffers. The script this ports wrote them back into the
 * parts dir, but that dir is an INPUT here (reads are deliberately unconfined),
 * so the tool never writes there — only under the confined outDir.
 */
async function prepEyeSplit(
  partsDir: string,
): Promise<{ sclera: Buffer; lash: Buffer }> {
  const srcPath = path.join(partsDir, EYEWHITE_SRC);
  if (!fs.existsSync(srcPath)) {
    throw new AutoRigInputError(`missing eyewhite source: ${srcPath}`);
  }
  const { width: W, height: H, rgba: data } = await decodePng(srcPath);

  // Eye content bbox (alpha) → the shared cropped frame for both outputs.
  let minX = W;
  let minY = H;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) {
    throw new AutoRigInputError(`eyewhite is fully transparent: ${srcPath}`);
  }
  // Keep only the upper lash: dark pixels above this row become the lash layer.
  const lashCutoffY = minY + LASH_KEEP_FRACTION * (maxY - minY + 1);

  const sclera = Buffer.from(data);
  const lash = Buffer.from(data);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const isDark = data[i + 3] > 0 && lum < EYE_LASH_LUMA;
      if (isDark) sclera[i] = sclera[i + 1] = sclera[i + 2] = 255; // dark -> white
      if (!(isDark && y <= lashCutoffY)) lash[i + 3] = 0; // keep upper dark only
    }
  }
  const region = {
    x: minX,
    y: minY,
    w: maxX - minX + 1,
    h: maxY - minY + 1,
  };
  return {
    sclera: await cropToBuffer(sclera, W, H, region),
    lash: await cropToBuffer(lash, W, H, region),
  };
}

/**
 * Cut the nose out of a full-canvas face layer (straight-alpha RGBA, CANVAS
 * square). `box` is the search window in canvas px: the gap between the eyes,
 * from the eye line to the mouth. Returns the face with skin filled in behind
 * the nose, the nose alone on its own transparent canvas, and the nose's alpha
 * bbox — or null when the window holds no drawn nose (see NOSE_MIN_PIXELS).
 * Both outputs are fresh buffers; the input is not touched.
 */
function cutNose(
  rgba: Buffer,
  box: { x0: number; y0: number; x1: number; y1: number },
): {
  face: Buffer;
  nose: Buffer;
  bbox: { x: number; y: number; w: number; h: number };
} | null {
  const W = CANVAS;
  const x0 = Math.max(0, box.x0);
  const y0 = Math.max(0, box.y0);
  const x1 = Math.min(W, box.x1);
  const y1 = Math.min(W, box.y1);
  if (x1 - x0 < 4 || y1 - y0 < 4) return null;
  const bw = x1 - x0;
  const bh = y1 - y0;
  const at = (x: number, y: number) => (y * W + x) * 4;

  // The skin colour is a per-channel median — per ROW, with the window's
  // median as the fallback for a row too empty to have one. The nose is a
  // small minority of every row, so a row's median is its skin; measured
  // against the window's median instead, a face shaded top-to-bottom had its
  // whole upper and lower bands read as ink.
  const median = (v: number[]) => v.sort((a, b) => a - b)[v.length >> 1];
  const all: number[][] = [[], [], []];
  const rows: number[][][] = [];
  for (let y = y0; y < y1; y++) {
    const row: number[][] = [[], [], []];
    for (let x = x0; x < x1; x++) {
      const i = at(x, y);
      if (rgba[i + 3] === 0) continue;
      for (let c = 0; c < 3; c++) {
        row[c].push(rgba[i + c]);
        all[c].push(rgba[i + c]);
      }
    }
    rows.push(row);
  }
  const opaqueCount = all[0].length;
  if (opaqueCount === 0) return null;
  const skin = all.map(median);
  const skinRow = rows.map((row) =>
    row[0].length < NOSE_ROW_MIN_PIXELS ? skin : row.map(median),
  );
  const distAt = (i: number, y: number): number => {
    const ref = skinRow[y - y0];
    return Math.max(
      Math.abs(rgba[i] - ref[0]),
      Math.abs(rgba[i + 1] - ref[1]),
      Math.abs(rgba[i + 2] - ref[2]),
    );
  };

  // Ink: every opaque pixel further than NOSE_INK_TOL from the skin seeds the
  // nose; from there it grows into any touching pixel further than
  // NOSE_INK_LOW (hysteresis). The bridge highlight beside the shadow sits in
  // that band — too close to skin to seed, but part of the nose: left on the
  // face it showed as a pale patch once the nose moved off it.
  const dist = new Uint8Array(bw * bh);
  const ink = new Uint8Array(bw * bh);
  const queue: number[] = [];
  let inkCount = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = at(x, y);
      if (rgba[i + 3] === 0) continue;
      const d = distAt(i, y);
      const k = (y - y0) * bw + (x - x0);
      dist[k] = d;
      if (d > NOSE_INK_TOL) {
        ink[k] = 1;
        queue.push(k);
        inkCount++;
      }
    }
  }
  if (inkCount < NOSE_MIN_PIXELS) return null;
  // The growth reaches NOSE_GROW px, not just the next pixel: the highlight
  // is usually parted from the shadow's outline by a sliver of skin.
  while (queue.length > 0) {
    const k = queue.pop()!;
    const kx = k % bw;
    const ky = (k - kx) / bw;
    for (let dy = -NOSE_GROW; dy <= NOSE_GROW; dy++) {
      for (let dx = -NOSE_GROW; dx <= NOSE_GROW; dx++) {
        const nx = kx + dx;
        const ny = ky + dy;
        if (nx < 0 || nx >= bw || ny < 0 || ny >= bh) continue;
        const n = ny * bw + nx;
        if (ink[n] === 0 && dist[n] > NOSE_INK_LOW) {
          ink[n] = 1;
          queue.push(n);
        }
      }
    }
  }

  // The cut region is the ink grown by NOSE_GROW, clipped to the window.
  const cut = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      if (ink[y * bw + x] === 0) continue;
      for (let dy = -NOSE_GROW; dy <= NOSE_GROW; dy++) {
        for (let dx = -NOSE_GROW; dx <= NOSE_GROW; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy >= 0 && yy < bh && xx >= 0 && xx < bw) cut[yy * bw + xx] = 1;
        }
      }
    }
  }

  // Two reasons to leave the face whole rather than decompose it. A nose is a
  // compact minority of the window: a cut over a large share of it is shading
  // (or a feature this was not written for), and moving that would drag bands
  // of skin around. And a cut holding a partly transparent pixel would double
  // its coverage — the nose keeps it AND the face keeps skin under it — so the
  // drawing would change at rest.
  let cutCount = 0;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      if (cut[y * bw + x] === 0) continue;
      const a = rgba[at(x0 + x, y0 + y) + 3];
      if (a === 0) continue;
      if (a < 255) return null;
      cutCount++;
    }
  }
  if (cutCount > NOSE_MAX_CUT_FRACTION * opaqueCount) return null;

  const face = Buffer.from(rgba);
  // The nose starts as the face with its alpha cleared, not as zeros: the
  // renderer samples the texture with linear filtering, and at the cut's edge
  // a transparent BLACK neighbour bleeds in as a dark outline around the nose.
  // Skin under the transparent pixels blends with skin instead.
  const nose = Buffer.from(rgba);
  for (let i = 3; i < nose.length; i += 4) nose[i] = 0;
  let minX = W;
  let minY = W;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < bh; y++) {
    const cy = y0 + y;
    let x = 0;
    while (x < bw) {
      if (cut[y * bw + x] === 0) {
        x++;
        continue;
      }
      // One run of cut pixels: the nose keeps the original pixels, the face
      // gets a straight blend between the skin on either side of the run (or
      // the window's skin where the run meets the window edge), which keeps
      // the face's own vertical shading across the patch.
      const start = x;
      while (x < bw && cut[y * bw + x] === 1) x++;
      const end = x;
      // The blend's endpoints must be SKIN: the pixel right beside the cut is
      // often the nose's own highlight, and a fill blended toward it came out
      // paler than the face around it — a ghost the leading nose uncovers.
      // Walk outward past anything off the skin colour; failing that, use the
      // window's median.
      const skinAt = (bx: number): number => {
        for (
          let step = 0;
          step < NOSE_FILL_REACH && bx >= 0 && bx < bw;
          step++
        ) {
          const i = at(x0 + bx, cy);
          if (rgba[i + 3] > 0 && cut[y * bw + bx] === 0) {
            if (distAt(i, cy) <= NOSE_INK_TOL / 2) return i;
          }
          bx += bx < start ? -1 : 1;
        }
        return -1;
      };
      const l = skinAt(start - 1);
      const r = skinAt(end);
      for (let k = start; k < end; k++) {
        const cx = x0 + k;
        const i = at(cx, cy);
        if (rgba[i + 3] === 0) continue;
        const t = (k - start + 1) / (end - start + 1);
        for (let c = 0; c < 3; c++) {
          const rowSkin = skinRow[y];
          const lc = l >= 0 ? rgba[l + c] : r >= 0 ? rgba[r + c] : rowSkin[c];
          const rc = r >= 0 ? rgba[r + c] : l >= 0 ? rgba[l + c] : rowSkin[c];
          face[i + c] = Math.round(lc * (1 - t) + rc * t);
        }
        // The cut keeps the original pixels at their original alpha — no
        // feathered rim: the rim is skin over skin already, and a ring of
        // half-alpha skin was the atlas's only semi-transparent skin, which
        // palette quantization rendered as a visible outline.
        nose[i] = rgba[i];
        nose[i + 1] = rgba[i + 1];
        nose[i + 2] = rgba[i + 2];
        nose[i + 3] = rgba[i + 3];
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
      }
    }
  }
  if (maxX < 0) return null;
  return {
    face,
    nose,
    bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
  };
}

/**
 * Compose a parts directory into role-named layers plus a flattened preview,
 * then measure the result so the caller sees the geometry checks inline.
 *
 * Error boundary: ONLY AutoRigInputError (caller input / filesystem) →
 * `{ ok:false }`, matching autoRigFromLayers; any other throw propagates.
 */
export async function composeLayersFromParts(
  input: ComposeInput,
): Promise<ComposeResult> {
  try {
    // Resolve the output dir FIRST (fail-fast): reject a missing or escaping
    // target before spending the decode budget on a run that cannot be written.
    const outDir = resolveOutputDir(input.outDir);
    const partsDir = resolveInputDir(input.partsDir);
    // resolveOutputDir already realpath's outDir; resolveInputDir does not (its
    // reads are deliberately unconfined), so realpath partsDir here too before
    // comparing — otherwise a symlink alias of the same directory would slip
    // past a lexical check. Composing a parts dir into itself would overwrite
    // originals like face.png/hair_front.png with resized, cropped layers, and
    // skipped-role cleanup would delete sources with no surviving part.
    if (fs.realpathSync(partsDir) === outDir) {
      throw new AutoRigInputError(
        `partsDir and outDir resolve to the same directory (${outDir}): composing would overwrite the source parts`,
      );
    }
    const layout = resolveLayout(input.layout);

    const split = await prepEyeSplit(partsDir);
    const splitSources = new Map<string, Buffer>([
      ["eyewhite_sclera.png", split.sclera],
      ["eyewhite_lash.png", split.lash],
    ]);

    const layers: ComposedLayer[] = [];
    const skipped: LayerRole[] = [];
    const preview: { input: Buffer; left: number; top: number }[] = [];
    // The face is written after the loop: its nose is cut out once the eye and
    // mouth placements that bound the cut are known.
    let faceRaw: Buffer | undefined;
    for (const role of ORDER) {
      const cfg = layout[role];
      const part = await partBuffer(
        role,
        cfg,
        partsDir,
        splitSources.get(cfg.src),
      );
      if (part === null) {
        skipped.push(role);
        // Drop this role's layer from an earlier compose into the same dir:
        // left behind it would contradict `skipped`, since measureDir globs the
        // directory (the report would still show a body) and the next
        // auto_rig_from_layers would rig the stale file into the model. Only the
        // fixed ORDER role names, under the confined outDir, are ever removed.
        fs.rmSync(path.join(outDir, `${role}.png`), { force: true });
        continue;
      }
      const { left, top } = placement(role, cfg, part.w, part.h);
      // role layer: this part alone on a full canvas at its position.
      const composed = blankCanvas().composite([
        { input: part.buf, left, top },
      ]);
      const outPath = path.join(outDir, `${role}.png`);
      if (role === "face") {
        faceRaw = await composed.raw().toBuffer();
      } else {
        writeFileAtomic(outPath, await composed.png().toBuffer());
      }
      layers.push({
        role,
        path: outPath,
        width: part.w,
        height: part.h,
        left,
        top,
      });
      preview.push({ input: part.buf, left, top });
    }

    // The nose: cut out of the placed face between the eyes, from the eye line
    // down to the mouth. The three roles are required, so they are all placed.
    const placed = (role: Role) => layers.find((l) => l.role === role)!;
    const eyeL = placed("eye_L");
    const eyeR = placed("eye_R");
    const mouth = placed("mouth");
    const noseCut = cutNose(faceRaw!, {
      x0: eyeR.left + eyeR.width,
      x1: eyeL.left,
      y0: Math.round(
        (eyeL.top + eyeL.height / 2 + eyeR.top + eyeR.height / 2) / 2,
      ),
      y1: mouth.top - 2,
    });
    const rawCanvas = {
      raw: { width: CANVAS, height: CANVAS, channels: 4 as const },
    };
    const facePath = path.join(outDir, "face.png");
    const nosePath = path.join(outDir, "nose.png");
    if (noseCut === null) {
      // No drawn nose: the face goes out as placed and, as with a skipped
      // optional role, an earlier compose's nose.png must not survive.
      writeFileAtomic(
        facePath,
        await sharp(faceRaw!, rawCanvas).png().toBuffer(),
      );
      fs.rmSync(nosePath, { force: true });
      skipped.push("nose");
    } else {
      writeFileAtomic(
        facePath,
        await sharp(noseCut.face, rawCanvas).png().toBuffer(),
      );
      writeFileAtomic(
        nosePath,
        await sharp(noseCut.nose, rawCanvas).png().toBuffer(),
      );
      // Draw order: right after the face, under the mouth.
      layers.splice(layers.findIndex((l) => l.role === "face") + 1, 0, {
        role: "nose",
        path: nosePath,
        width: noseCut.bbox.w,
        height: noseCut.bbox.h,
        left: noseCut.bbox.x,
        top: noseCut.bbox.y,
      });
      // The preview already shows the face with its nose drawn in place.
    }

    // Flattened preview over a light bg so transparency reads clearly.
    const previewPng = await sharp({
      create: {
        width: CANVAS,
        height: CANVAS,
        channels: 4,
        background: { r: 245, g: 245, b: 248, alpha: 1 },
      },
    })
      .composite(preview)
      .png()
      .toBuffer();
    const previewPath = path.join(outDir, "preview.png");
    writeFileAtomic(previewPath, previewPng);

    return {
      ok: true,
      outDir,
      layers,
      skipped,
      preview: previewPath,
      measure: await measureDir(outDir),
    };
  } catch (err) {
    if (err instanceof AutoRigInputError)
      return { ok: false, error: err.message };
    throw err;
  }
}
