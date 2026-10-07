/**
 * Compose AI-generated part PNGs into canvas-aligned, role-named layers for the
 * Iki auto-rig (`auto_rig_from_layers` / `@ikijs/editor` generateIkiFromLayerSet).
 * Each part is alpha-trimmed, resized to a target width, optionally mirrored,
 * and pasted at a chosen center on a shared transparent CANVAS x CANVAS canvas
 * — the nose by its dense core, the drawing inside a soft nose's feather.
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
import { ALPHA_OPAQUE, detectAlphaBbox as scanAlphaBbox } from "@ikijs/editor";
import { cropToBuffer, decodePng } from "./node-images";
import { measureDir, type MeasureReport, type NoseSpeck } from "./measure";
import { denseCoreOf, isSpeckCore } from "./measure-turn";
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
// bead floating in white; the defaults below are the hero bob's, 50px in a
// 98px opening (0.51). A caller retunes eye size through
// `layout.eye_L/eye_R.w` and MUST move `layout.iris_L/iris_R.w` with it to keep
// that ratio.
const EYE_W = 98;
const IRIS_W = 50;

/** The eyewhite source that prepEyeSplit() splits into sclera + lash. */
const EYEWHITE_SRC = "eyewhite.png";
/** Luminance below this (0..255) = a dark lash/outline pixel in the eyewhite. */
const EYE_LASH_LUMA = 120;
// Of the eye's dark pixels, those in the TOP this-fraction are the upper lash,
// an arc that folds DOWN over the eye on blink instead of a full ring that
// shrinks in place; those below it are the lower lid's line and lashes.
const LASH_KEEP_FRACTION = 0.5;

/** The alpha a part's trim cuts at: what it keeps is over this. */
const TRIM_THRESHOLD = 12;
/** Of a part's kept pixels, the share under which a faint detached set is a stray speck. */
const STRAY_SPECK_FRACTION = 0.01;

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

/**
 * The nose's layout. Its `w`, `h` and `cx` size and place its dense core
 * (`denseCoreOf`), not its whole trimmed part: a soft nose is mostly feather,
 * and sized by its extent it renders as a dot. A part with no core, or whose
 * core is a speck of it (`isSpeckCore`: a lone nostril mark or highlight,
 * which sized to `w` would blow the whole nose up), is sized and placed whole
 * instead, and the speck is warned about. Unlike every other role's, its `cy`
 * is optional. Set, it is the core's centre row; absent, the core's bottom row
 * — the tip — lands NOSE_TIP_AT of the way from the eye row down to the
 * mouth's.
 */
interface NoseLayout extends Omit<RoleLayout, "cy"> {
  cy?: number;
}

/** A box in a part's own px, origin top-left. */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where a nose with no `cy` puts its tip, as a fraction of the way from the
 * eye row down to the mouth's. Bob's: tip row 554 between eye row 475 and
 * mouth row 594 (79/119 ≈ 0.66), so the default rows land bob's nose where his
 * own layout placed it.
 */
const NOSE_TIP_AT = 0.66;

// ── DEFAULT LAYOUT (tune per character through `layout`) ──────────────────────
// These defaults assume the standard framing the character skill prompts for
// (a front-facing face centered on the canvas). The face, eyes, irises,
// lashes, brows, nose and mouth are the hero bob's own tuning; bob wears his
// blush at its default placement, picked on his face (below). The features'
// defaults are proportions of the face: resolveLayout carries them with the
// face's cx, cy and w. The hair and
// the torso depend on the hairstyle and on how the torso is framed, so they are
// older defaults every character retunes from the report. If the rendered model is misaligned, tune cx/cy/w through the
// `layout` override and re-run — composing is cheap and the parts do not need
// regenerating.
//
// eyeSide reminder: eye_L = character's LEFT eye = screen RIGHT (larger cx).
// Which way a source faces is fixed by the mirror flags below, and "left eye"
// cannot say it — it reads as the viewer's left or the character's. So in
// image terms: eyewhite.png is the eye on the SCREEN LEFT, its lash wing (outer
// corner) at the image's left end and its lash-free tear duct at the right;
// brow.png is the brow on the SCREEN RIGHT, its thick head at the image's left
// end and its tail at the right; blush.png is the blush on the SCREEN LEFT,
// its outer end (toward the face's edge) at the image's left end and its
// inner end (toward the nose) at the right. A part drawn the other way round
// is flipped for free with `mirrorParts`.
// eye_*  = the WHITE sclera (upper lashes recolored white) = the blink clip mask + fold.
// iris_* = colored disc on top, clipped to the sclera, drives gaze.
// lash_lower_* = the lower lid's dark line and lashes, ABOVE the iris (it
//          covers the iris's bottom edge, as the drawing does) and folding
//          with the white. Placed on the eye's frame, so it has no layout key.
// lash_* = the dark upper lashes, a separate layer ABOVE the iris that folds
//          down to cover the closed-eye seam. eye_*, lash_lower_* and lash_* are
//          split from a single `eyewhite.png` (white almond + dark lashes) by
//          prepEyeSplit().
const DEFAULT_LAYOUT = {
  // Back hair and body sit behind the face. Both are OPTIONAL: a parts dir
  // without them still composes (head-only character).
  hair_back: { src: "hair_back.png", cx: 550, cy: 523, w: 800, optional: true },
  // The torso, cut off by the canvas bottom, so the character is not a
  // floating head. It rides the rig's `bodyWarp`, which the head hangs from.
  body: { src: "body.png", cx: 550, cy: 1017, w: 840, optional: true },
  // The face is drawn without a neck, so its box is the skull and centres
  // above the eye row (bob's skull at 437 against his eyes' 475).
  face: { src: "face.png", cx: 550, cy: 437, w: 400 },
  // The cheek blush, one part for both cheeks: blush_R (screen left) takes it
  // as drawn and blush_L mirrors it, like the eyewhite. It draws over the face
  // and under the nose. Its box sits below each eye, centred 5 px outside the
  // eye's centre and 55 px under its row, above the nose tip: on bob's face,
  // which narrows fast below the eye row, a 2:1 blush there stays on the
  // cheek through the turn, where one 26 px further out reached the ears.
  // OPTIONAL: a parts dir without it composes, and nothing reports it missing.
  blush_L: { src: "blush.png", cx: 641, cy: 530, w: 56, optional: true, mirror: true }, // prettier-ignore
  blush_R: { src: "blush.png", cx: 459, cy: 530, w: 56, optional: true, mirror: false }, // prettier-ignore
  // The nose, drawn on its own (the face is drawn without one): the auto-rig
  // leads the head turn with it and keys the other features' slide on its
  // presence, so without it the features stay on the face plate. `w` is the
  // width of its dense core, and it has no `cy`: its row comes from the tip
  // rule (NOSE_TIP_AT), between the eyes and the mouth, so it follows them
  // when they are retuned. OPTIONAL: a parts dir without it composes.
  nose: { src: "nose.png", cx: 550, w: 20, optional: true },
  mouth: { src: "mouth.png", cx: 550, cy: 594, w: 76 },
  // Cross-fades with `mouth` on ParamMouthOpenY (opacity, not scaleY) once the
  // auto-rig sees both roles. Same cx/w as `mouth` so the lip width matches;
  // its top edge (not center) lines up with the closed mouth's top edge since
  // the mouth opens downward from a fixed upper lip — hence the +2 cy nudge
  // rather than sharing cy outright. Optional: composes fine without it.
  mouth_open: {
    src: "mouth_open.png",
    cx: 550,
    cy: 596,
    w: 76,
    optional: true,
  },
  // eye_* (sclera) and lash_* share the eyewhite's cropped frame via noTrim (so
  // they are NOT re-bboxed independently): the upper lash stays anchored ABOVE
  // the sclera center, so on blink it folds DOWN over the eye like the sample
  // model instead of the whole eye shrinking in place. Same cx/cy/w.
  eye_L: { src: "eyewhite_sclera.png", cx: 636, cy: 475, w: EYE_W, mirror: true, noTrim: true }, // prettier-ignore
  eye_R: { src: "eyewhite_sclera.png", cx: 464, cy: 475, w: EYE_W, mirror: false, noTrim: true }, // prettier-ignore
  // A little under the white's centre and toward the nose, as bob's sits.
  iris_L: { src: "iris.png", cx: 631, cy: 480, w: IRIS_W, mirror: false },
  iris_R: { src: "iris.png", cx: 469, cy: 480, w: IRIS_W, mirror: false },
  lash_L: {
    src: "eyewhite_lash.png",
    cx: 636,
    cy: 475,
    w: EYE_W,
    mirror: true,
    noTrim: true,
  },
  lash_R: { src: "eyewhite_lash.png", cx: 464, cy: 475, w: EYE_W, mirror: false, noTrim: true }, // prettier-ignore
  brow_L: { src: "brow.png", cx: 645, cy: 405, w: 105, mirror: false },
  brow_R: { src: "brow.png", cx: 455, cy: 405, w: 105, mirror: true },
  hair_front: { src: "hair_front.png", cx: 550, cy: 425, w: 660 },
} satisfies Record<string, RoleLayout | NoseLayout>;

export type Role = keyof typeof DEFAULT_LAYOUT;

/** The lower lash of each eye, and the eye whose placement it takes. */
const LOWER_LASH = { lash_lower_L: "eye_L", lash_lower_R: "eye_R" } as const;
/** The eyewhite's lower lid, split in memory like the sclera and lash. */
const LOWER_LASH_SRC = "eyewhite_lash_lower.png";

/** A role the composer writes a layer for. */
export type LayerRole = Role | keyof typeof LOWER_LASH;

/**
 * The merged layout, typed so a non-nose default that drops its `cy` fails to
 * compile: `resolveLayout` builds it from DEFAULT_LAYOUT.
 */
type ResolvedLayout = Record<Exclude<Role, "nose">, RoleLayout> & {
  nose: NoseLayout;
};

/** Draw order (back -> front), mirrors @ikijs/editor ROLE_TABLE order. */
const ORDER: LayerRole[] = [
  "hair_back",
  "body",
  "face",
  "blush_L",
  "blush_R",
  "nose",
  "mouth",
  "mouth_open",
  "eye_L",
  "eye_R",
  "iris_L",
  "iris_R",
  "lash_lower_L",
  "lash_lower_R",
  "lash_L",
  "lash_R",
  "brow_L",
  "brow_R",
  "hair_front",
];

/**
 * The part files a parts dir holds: every source the layout reads from disk,
 * and the eyewhite the eye pair is split from in memory.
 */
const PART_FILES = [
  ...new Set(
    Object.values(DEFAULT_LAYOUT)
      .map((cfg) => cfg.src)
      .filter((src) => !src.startsWith("eyewhite_")),
  ),
  EYEWHITE_SRC,
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
  /**
   * Part files to flip left-right as they are read, e.g. `["eyewhite.png"]`
   * for an eye drawn facing the other way. It flips the SOURCE, so every role
   * cut from it flips together — the eye pair's sclera and lash stay in one
   * frame, which a per-role flag would leave to the caller to keep in sync.
   */
  mirrorParts?: string[];
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
      /**
       * Roles whose optional part was absent from the parts dir, and the lower
       * lashes when the eyewhite draws no dark lower lid.
       */
      skipped: LayerRole[];
      preview: string;
      measure: MeasureReport;
    }
  | { ok: false; error: string };

/**
 * The roles drawn on the face, but the nose (resolveLayout places it on its
 * own). Their defaults are placed relative to the face's: a layout that moves
 * or scales the face carries them with it.
 */
const FACE_FEATURES = [
  "blush_L",
  "blush_R",
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
] as const satisfies readonly Exclude<Role, "nose">[];

/**
 * Merge caller overrides onto the defaults. Input boundary: an unknown role, a
 * non-finite centre or an out-of-range width fails fast, path-qualified, before
 * any decode. `w` is capped at CANVAS so a part sized whole can never exceed
 * the canvas width (a nose, sized by its core, is checked in partBuffer);
 * `cx`/`cy` are unbounded here because a part may legitimately hang off an
 * edge — assertOnCanvas() rejects the one that lands nowhere on it.
 *
 * The face's override applies first. Each feature's default is then moved
 * with the face's centre and scaled by its width against the default face's,
 * so the defaults are proportions of the face; a feature's own override still
 * names canvas px.
 */
function resolveLayout(overrides: LayoutOverride | undefined): ResolvedLayout {
  const resolved: ResolvedLayout = { ...DEFAULT_LAYOUT };
  if (overrides === undefined) return resolved;
  const sets = new Map<
    Role,
    { cx?: number; cy?: number; w?: number; h?: number }
  >();
  for (const [role, override] of Object.entries(overrides)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_LAYOUT, role)) {
      throw new AutoRigInputError(
        `layout.${role}: unknown role — expected one of ${Object.keys(DEFAULT_LAYOUT).join(", ")}`,
      );
    }
    if (override === undefined) continue;
    // Only the fields the override sets: spread over the entry, an explicit
    // undefined would erase the default it leaves alone.
    const set: { cx?: number; cy?: number; w?: number; h?: number } = {};
    for (const field of ["cx", "cy"] as const) {
      const value = override[field];
      if (value === undefined) continue;
      if (!Number.isFinite(value)) {
        throw new AutoRigInputError(
          `layout.${role}.${field} must be a finite number, got ${String(value)}`,
        );
      }
      set[field] = value;
    }
    for (const field of ["w", "h"] as const) {
      const value = override[field];
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < 1 || value > CANVAS) {
        throw new AutoRigInputError(
          `layout.${role}.${field} must be an integer in 1..${CANVAS}, got ${String(value)}`,
        );
      }
      set[field] = value;
    }
    sets.set(role as Role, set);
  }
  const face = { ...resolved.face, ...sets.get("face") };
  resolved.face = face;
  const base = DEFAULT_LAYOUT.face;
  const scale = face.w / base.w;
  const x = (cx: number) => face.cx + (cx - base.cx) * scale;
  const w = (width: number) => Math.max(1, Math.round(width * scale));
  for (const role of FACE_FEATURES) {
    const d = DEFAULT_LAYOUT[role];
    const cy = face.cy + (d.cy - base.cy) * scale;
    resolved[role] = { ...d, cx: x(d.cx), cy, w: w(d.w), ...sets.get(role) };
  }
  // The nose has no default cy (the tip rule places it, off the eye and
  // mouth rows above), so it merges on its own.
  const nose = DEFAULT_LAYOUT.nose;
  resolved.nose = {
    ...nose,
    cx: x(nose.cx),
    w: w(nose.w),
    ...sets.get("nose"),
  };
  for (const [role, set] of sets) {
    if (role === "face" || role === "nose") continue;
    if ((FACE_FEATURES as readonly Role[]).includes(role)) continue;
    resolved[role] = { ...resolved[role], ...set };
  }
  return resolved;
}

/**
 * Input boundary for `mirrorParts`: a name that is not a part file (a typo, or
 * a role such as `eye_L`) would otherwise flip nothing and read as success.
 */
function resolveMirrorParts(names: string[] | undefined): Set<string> {
  const mirrored = new Set<string>();
  for (const [i, name] of (names ?? []).entries()) {
    if (!PART_FILES.includes(name)) {
      throw new AutoRigInputError(
        `mirrorParts[${i}]: unknown part ${JSON.stringify(name)} — expected one of ${PART_FILES.join(", ")}`,
      );
    }
    mirrored.add(name);
  }
  return mirrored;
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

/** A PNG part's dense core (`null` when no pixel reaches the core's alpha)
 *  and its own bounds, both in its own px. */
async function coreAndBoundsOf(
  png: Buffer,
): Promise<{ core: Box | null; bounds: Box }> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    core: denseCoreOf(data, info.width, info.height),
    bounds: { x: 0, y: 0, w: info.width, h: info.height },
  };
}

/** Whether a part keeps a pixel the auto-rig counts as coverage. */
async function hasCoverage(png: Buffer): Promise<boolean> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return scanAlphaBbox(data, info.width, info.height) !== null;
}

/** What a nose part's layout sizes, decided on the trimmed source part. */
interface NoseSizing {
  /** The box layout `w`/`h` size, in the trimmed source part's px (not the
   *  resized part's). */
  box: Box;
  /** The whole part stood in for the core: it has none, or it is a speck. */
  whole: boolean;
  /** The core's and the part's sizes when a speck was the reason. */
  speck?: NoseSpeck;
}

/**
 * What a nose part's layout sizes: its dense core, in its own px — or its own
 * bounds, so it is sized and placed whole, when no pixel reaches the core's
 * alpha (a nose painted wholly translucent) or the core is a speck of those
 * bounds (`isSpeckCore`).
 */
async function noseSizingOf(png: Buffer): Promise<NoseSizing> {
  const { core, bounds } = await coreAndBoundsOf(png);
  if (core === null) return { box: bounds, whole: true };
  if (isSpeckCore(core, bounds)) {
    return {
      box: bounds,
      whole: true,
      speck: {
        core: { w: core.w, h: core.h },
        part: { w: bounds.w, h: bounds.h },
      },
    };
  }
  return { box: core, whole: false };
}

/**
 * Trim/mirror a part and resize it to its layout width. The nose is resized so
 * its dense core, not its whole part, comes out `w` wide (and `h` tall when
 * set), unless its whole part stood in for the core. Either way the nose's
 * sizing decision (`noseSizingOf`) always comes back as `nose`, and no other
 * role has one. `inMemory` carries the eye pair's two split buffers; every
 * other role is read from the parts dir. `flipSource` is a `mirrorParts` entry
 * for the file the role is cut from.
 * Missing optional part -> null; missing required part -> AutoRigInputError.
 */
async function partBuffer(
  role: LayerRole,
  cfg: Omit<RoleLayout, "cy">,
  partsDir: string,
  inMemory: Buffer | undefined,
  flipSource: boolean,
): Promise<{ buf: Buffer; w: number; h: number; nose?: NoseSizing } | null> {
  let img: sharp.Sharp;
  if (inMemory !== undefined) {
    img = sharp(inMemory);
  } else {
    const srcPath = path.join(partsDir, cfg.src);
    if (!fs.existsSync(srcPath)) {
      // An optional role's part may be absent from the parts dir; the
      // auto-rig only requires face/eye_L/eye_R/mouth.
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
  // sclera and lash stay aligned; everything else is alpha-trimmed to its own
  // bbox, less any stray speck beside the drawing.
  if (!cfg.noTrim) {
    // The rest of the pipeline reads this trimmed raw, so the source is
    // decoded and trimmed once. Only file sources are trimmed, and they are
    // raw already, so a part with no stray speck composes byte-identically.
    const kept = await img
      .trim({ threshold: TRIM_THRESHOLD })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width: keptW, height: keptH } = kept.info;
    img = sharp(kept.data, {
      raw: { width: keptW, height: keptH, channels: 4 },
    });
    const box = boxWithoutStraySpecks(kept.data, keptW, keptH);
    if (box !== null) img = img.extract(box);
  }
  // A flipped source under a mirrored role cancels out. sharp's flop() sets a
  // flag rather than toggling it, so the two cannot simply be applied in turn.
  if ((cfg.mirror ?? false) !== flipSource) img = img.flop();
  // Materialise the trimmed part BEFORE resizing: its size is bounded by the
  // source decode limit, so the size the resize WOULD produce can be checked
  // against the canvas while only the bounded buffer is allocated.
  const trimmed = await img.png().toBuffer({ resolveWithObject: true });
  const { width: trimmedW, height: trimmedH } = trimmed.info;
  // What `w`/`h` size: the nose's dense core, measured on the trimmed, flipped
  // part — the whole part scales with it, feather and all — or that whole
  // part when it has no core or the core is a speck, and every other role's
  // whole part.
  const nose = role === "nose" ? await noseSizingOf(trimmed.data) : undefined;
  const sized = nose?.box ?? { x: 0, y: 0, w: trimmedW, h: trimmedH };
  const width = Math.round((trimmedW * cfg.w) / sized.w);
  const height =
    cfg.h === undefined
      ? Math.round((trimmedH * width) / trimmedW)
      : Math.round((trimmedH * cfg.h) / sized.h);
  // resolveLayout bounds w and an explicit h, so for a part sized whole only
  // the aspect-derived height can run past the canvas; a nose sized by its
  // core can overrun either dimension.
  if (width > CANVAS || height > CANVAS) {
    const field = width > CANVAS || cfg.h === undefined ? "w" : "h";
    throw new AutoRigInputError(
      `layout.${role}.${field}: resized part ${width}x${height} exceeds the ${CANVAS} canvas`,
    );
  }
  const resized = await sharp(trimmed.data)
    // Width alone keeps the source aspect. With h, fit:"fill" is the point —
    // stretch to the given box instead. Both options stay off the width-only
    // path: passing height:undefined alongside fit:"fill" makes sharp drop the
    // aspect it would otherwise preserve.
    .resize(cfg.h === undefined ? { width } : { width, height, fit: "fill" })
    .png()
    .toBuffer({ resolveWithObject: true });
  return {
    buf: resized.data,
    w: resized.info.width,
    h: resized.info.height,
    nose,
  };
}

/**
 * Refuse a placed part that lands nowhere on the canvas. Running off an edge is
 * legitimate — `body` is meant to be cut off by the canvas bottom — so the test
 * is INTERSECTION, not containment. A part that misses the canvas entirely
 * composes to a fully transparent layer that nothing downstream flags
 * (measureDir warns per measured layer, and an empty one has no geometry), so a
 * sign-flipped centre would otherwise read as success.
 */
function assertOnCanvas(
  source: string,
  w: number,
  h: number,
  left: number,
  top: number,
): void {
  if (left + w <= 0 || top + h <= 0 || left >= CANVAS || top >= CANVAS) {
    throw new AutoRigInputError(
      `${source}: the placed part (${w}x${h} at ${left},${top}) falls entirely outside the ${CANVAS} canvas`,
    );
  }
}

/** Where a part lands, centred on its layout cx/cy. The nose has its own. */
function placement(
  role: Exclude<Role, "nose">,
  cfg: RoleLayout,
  w: number,
  h: number,
) {
  const left = Math.round(cfg.cx - w / 2);
  const top = Math.round(cfg.cy - h / 2);
  assertOnCanvas(`layout.${role}.cx/cy`, w, h, left, top);
  return { left, top };
}

/**
 * Where the nose lands: by the box it was sized by (`noseSizingOf`), in the
 * resized part's px — its dense core, or its whole bounds when those stood in.
 * `cx` centres the box's columns. A set `cy` centres its rows; absent, its
 * bottom row — the tip, the last row index at alpha ≥ 128 — lands on
 * round(E + NOSE_TIP_AT·(M − E)), E the eyes' mean row and M the mouth's. A
 * box's centre is `x + w/2`, as placement() takes it: pixel x covers
 * [x, x + 1).
 */
function nosePlacement(layout: ResolvedLayout, box: Box, w: number, h: number) {
  const { cx, cy } = layout.nose;
  const left = Math.round(cx - (box.x + box.w / 2));
  let top: number;
  if (cy !== undefined) {
    top = Math.round(cy - (box.y + box.h / 2));
  } else {
    const eyeRow = (layout.eye_L.cy + layout.eye_R.cy) / 2;
    const tipRow = Math.round(
      eyeRow + NOSE_TIP_AT * (layout.mouth.cy - eyeRow),
    );
    top = tipRow - (box.y + box.h - 1);
  }
  assertOnCanvas(
    cy !== undefined
      ? "layout.nose.cx/cy"
      : "layout.nose.cx/cy (cy unset: its tip row comes from layout.eye_L/eye_R/mouth.cy)",
    w,
    h,
    left,
    top,
  );
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

/** Luma (0..255) of the RGBA pixel at byte offset `i`. */
function luma(rgba: Buffer, i: number): number {
  return 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
}

/**
 * The box of a trimmed part without its stray specks, or null when no stray
 * speck lies outside its drawing. The part's kept pixels (alpha over
 * TRIM_THRESHOLD, the trim's own cut) form 8-connected sets; a stray speck is
 * a set that never reaches ALPHA_OPAQUE and holds under STRAY_SPECK_FRACTION of
 * them, the residue a background removal leaves beside a drawing. Kept, one
 * such speck widened a generated body's box by 70 px on one side and placed
 * the body 32 px off its centre. A drawn stroke reaches ALPHA_OPAQUE, so a
 * detached wisp or strand is never dropped, and a part painted wholly under
 * it (a soft blush) drops nothing.
 */
function boxWithoutStraySpecks(
  rgba: Buffer,
  W: number,
  H: number,
): { left: number; top: number; width: number; height: number } | null {
  const n = W * H;
  // The share is of the whole part, so count it before any set is judged.
  let kept = 0;
  for (let p = 0; p < n; p++) if (rgba[p * 4 + 3] > TRIM_THRESHOLD) kept++;
  // Each set is judged as its fill ends and only its box is kept, so memory
  // is a byte per pixel plus a stack grown to the deepest fill, not a label
  // per pixel and a record per set. A pixel is marked as it is pushed, so the
  // stack never outgrows the image.
  const visited = new Uint8Array(n);
  let stack = new Int32Array(1024);
  // [left, top, right, bottom] of the drawing's sets and of the stray ones.
  const drawing = [W, H, -1, -1];
  const strays = [W, H, -1, -1];
  let anyOpaque = false;
  for (let start = 0; start < n; start++) {
    if (visited[start] || rgba[start * 4 + 3] <= TRIM_THRESHOLD) continue;
    let setLeft = W;
    let setTop = H;
    let setRight = -1;
    let setBottom = -1;
    let size = 0;
    let opaque = false;
    let depth = 0;
    visited[start] = 1;
    stack[depth++] = start;
    while (depth > 0) {
      const p = stack[--depth];
      size++;
      if (rgba[p * 4 + 3] >= ALPHA_OPAQUE) opaque = true;
      const px = p % W;
      const py = (p - px) / W;
      setLeft = Math.min(setLeft, px);
      setTop = Math.min(setTop, py);
      setRight = Math.max(setRight, px);
      setBottom = Math.max(setBottom, py);
      for (let y = Math.max(0, py - 1); y <= Math.min(H - 1, py + 1); y++) {
        for (let x = Math.max(0, px - 1); x <= Math.min(W - 1, px + 1); x++) {
          const q = y * W + x;
          if (!visited[q] && rgba[q * 4 + 3] > TRIM_THRESHOLD) {
            visited[q] = 1;
            if (depth === stack.length) {
              const grown = new Int32Array(Math.min(n, stack.length * 2));
              grown.set(stack);
              stack = grown;
            }
            stack[depth++] = q;
          }
        }
      }
    }
    anyOpaque ||= opaque;
    const into =
      !opaque && size < kept * STRAY_SPECK_FRACTION ? strays : drawing;
    into[0] = Math.min(into[0], setLeft);
    into[1] = Math.min(into[1], setTop);
    into[2] = Math.max(into[2], setRight);
    into[3] = Math.max(into[3], setBottom);
  }
  if (!anyOpaque || strays[2] < 0) return null;
  const [left, top, right, bottom] = drawing;
  // A set's box reaches past the drawing's only where one of its pixels does,
  // and a speck inside the drawing's box moves nothing, so it is left be.
  if (
    strays[0] >= left &&
    strays[1] >= top &&
    strays[2] <= right &&
    strays[3] <= bottom
  )
    return null;
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

/**
 * The eyewhite's light ink drawn detached above its white, as a row-major
 * mask (1 = detached). Light ink is non-transparent at luma EYE_LASH_LUMA or
 * over. Its sets are 8-connected through visibly painted pixels only (alpha
 * ALPHA_OPAQUE or over), so a faint antialiased pixel between a crease and
 * the white does not join them. Each fainter pixel is fringe of the nearest
 * painted set it reaches through faint pixels whose alpha never rises on the
 * way (ties go to the set met first in row-major order, the higher one).
 * Antialiasing fades away from what it edges, so a translucent stroke past a
 * fainter halo does not become the fringe of the set the halo edges. Faint
 * ink that no painted set reaches this way forms sets of its own. So does a
 * noisy faint pixel brighter than every claimed neighbour and touching no
 * painted pixel: above the white's top, it is dropped. The white is the
 * largest painted set. Another set is detached above it when each of its own
 * pixels, fringe aside, lies above the white's topmost painted pixel in its
 * column, or, past either end of the white, above the top of that end's
 * column; it goes with its fringe. A crease often runs on past the eye's
 * corners, and judged only over the white, one pixel out there would keep
 * the whole crease. A shade painted on the white touches it, so it is part
 * of the white; a mark below the white, or beside an end and level with it,
 * is left.
 */
function detachedAboveWhite(rgba: Buffer, W: number, H: number): Uint8Array {
  const n = W * H;
  // 2 = painted light ink, 1 = fainter light ink, 0 = neither.
  const ink = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    const alpha = rgba[p * 4 + 3];
    if (alpha > 0 && luma(rgba, p * 4) >= EYE_LASH_LUMA)
      ink[p] = alpha >= ALPHA_OPAQUE ? 2 : 1;
  }
  const label = new Int32Array(n).fill(-1);
  // A pixel is labelled as it is pushed, so it is pushed once and neither the
  // flood fill's stack nor the fringe's queue outgrows the image.
  const stack = new Int32Array(n);
  const near = (p: number, visit: (q: number) => void) => {
    const px = p % W;
    const py = (p - px) / W;
    for (let y = Math.max(0, py - 1); y <= Math.min(H - 1, py + 1); y++) {
      for (let x = Math.max(0, px - 1); x <= Math.min(W - 1, px + 1); x++) {
        visit(y * W + x);
      }
    }
  };
  const sizes: number[] = [];
  const fill = (start: number) => {
    const id = sizes.length;
    let size = 0;
    let depth = 0;
    label[start] = id;
    stack[depth++] = start;
    while (depth > 0) {
      const p = stack[--depth];
      size++;
      near(p, (q) => {
        if (ink[q] === ink[start] && label[q] === -1) {
          label[q] = id;
          stack[depth++] = q;
        }
      });
    }
    sizes.push(size);
  };
  for (let p = 0; p < n; p++) if (ink[p] === 2 && label[p] === -1) fill(p);
  const paintedSets = sizes.length;
  // The fringe: breadth-first from every painted pixel at once, each faint
  // pixel no more opaque than the one before taking the set that reaches it
  // first.
  let head = 0;
  let tail = 0;
  for (let p = 0; p < n; p++) if (ink[p] === 2) stack[tail++] = p;
  while (head < tail) {
    const p = stack[head++];
    near(p, (q) => {
      if (
        ink[q] === 1 &&
        label[q] === -1 &&
        rgba[q * 4 + 3] <= rgba[p * 4 + 3]
      ) {
        label[q] = label[p];
        stack[tail++] = q;
      }
    });
  }
  for (let p = 0; p < n; p++) if (ink[p] === 1 && label[p] === -1) fill(p);

  const detached = new Uint8Array(n);
  if (paintedSets === 0 || sizes.length < 2) return detached;
  let white = 0;
  for (let id = 1; id < paintedSets; id++) {
    if (sizes[id] > sizes[white]) white = id;
  }
  // A set's own pixels: a painted set's painted ones, a faint set's all.
  const own = (p: number) => ink[p] === 2 || label[p] >= paintedSets;
  // The white's topmost painted row per column (the scan is row-major, so
  // the first pixel met is the top).
  const whiteTop = new Int32Array(W).fill(-1);
  for (let p = 0; p < n; p++) {
    const x = p % W;
    if (label[p] === white && own(p) && whiteTop[x] === -1)
      whiteTop[x] = (p - x) / W;
  }
  // An 8-connected set covers one unbroken run of columns, so every column
  // the white misses lies past one of its ends and takes that end's top.
  let first = 0;
  while (whiteTop[first] === -1) first++;
  let last = W - 1;
  while (whiteTop[last] === -1) last--;
  whiteTop.fill(whiteTop[first], 0, first);
  whiteTop.fill(whiteTop[last], last + 1);
  const above = new Uint8Array(sizes.length).fill(1);
  for (let p = 0; p < n; p++) {
    const id = label[p];
    if (id === -1 || id === white || !own(p)) continue;
    const x = p % W;
    if ((p - x) / W >= whiteTop[x]) above[id] = 0;
  }
  for (let p = 0; p < n; p++) {
    const id = label[p];
    if (id !== -1 && id !== white && above[id]) detached[p] = 1;
  }
  return detached;
}

/**
 * Split eyewhite.png (white almond + dark lashes) into a sclera (the upper
 * lash recolored to white; the whole drawing's alpha = the blink clip-mask
 * shape), a dark UPPER-lash layer and a dark LOWER-lid layer. All are cropped
 * to the SAME eye bbox so they stay aligned (consumed with noTrim): the lash
 * arc keeps its position at the top of the sclera, so on blink it folds DOWN
 * over the eye rather than the eye shrinking in place.
 *
 * The lower lid's dark line and lashes stay in the sclera as drawn and are
 * copied into their own layer, which draws over the iris. Recolored white they
 * would show as white flicks wherever a lash hangs below the white, and left
 * in the sclera alone the iris would paint over the line. The sclera keeps
 * them so its alpha, which the rig measures the eye by, is the drawing's.
 * `lashLower` is null when the eyewhite draws no dark pixel below the upper
 * lash's fraction.
 *
 * A light mark drawn detached above the white, such as a double-eyelid crease,
 * is dropped from the sclera (`detachedAboveWhite`). The sclera is the iris's
 * clip, and at half blink the fold carries such a mark down into the iris's
 * path. The frame is still the source's alpha bbox, crease and all, so the
 * layout places the pair where it did before.
 *
 * Both come back as PNG buffers. The script this ports wrote them back into the
 * parts dir, but that dir is an INPUT here (reads are deliberately unconfined),
 * so the tool never writes there — only under the confined outDir.
 */
async function prepEyeSplit(
  partsDir: string,
): Promise<{ sclera: Buffer; lash: Buffer; lashLower: Buffer | null }> {
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
  // Dark pixels above this row are the upper lash; below it, the lower lid.
  const lashCutoffY = minY + LASH_KEEP_FRACTION * (maxY - minY + 1);
  const detached = detachedAboveWhite(data, W, H);

  const sclera = Buffer.from(data);
  const lash = Buffer.from(data);
  const lashLower = Buffer.from(data);
  let lowerInk = false;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const isDark = data[i + 3] > 0 && luma(data, i) < EYE_LASH_LUMA;
      const upper = y <= lashCutoffY;
      if (isDark && upper) sclera[i] = sclera[i + 1] = sclera[i + 2] = 255; // dark -> white
      if (detached[y * W + x]) sclera[i + 3] = 0;
      if (!(isDark && upper)) lash[i + 3] = 0;
      if (isDark && !upper) lowerInk = true;
      else lashLower[i + 3] = 0;
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
    lashLower: lowerInk ? await cropToBuffer(lashLower, W, H, region) : null,
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
    const mirrored = resolveMirrorParts(input.mirrorParts);

    const split = await prepEyeSplit(partsDir);
    const splitSources = new Map<string, Buffer>([
      ["eyewhite_sclera.png", split.sclera],
      ["eyewhite_lash.png", split.lash],
    ]);
    if (split.lashLower !== null) {
      splitSources.set(LOWER_LASH_SRC, split.lashLower);
    }

    // Place every role before writing any: a rejected placement must leave
    // outDir as the last compose left it, not half overwritten.
    const placed: {
      role: LayerRole;
      part: { buf: Buffer; w: number; h: number };
      left: number;
      top: number;
    }[] = [];
    const skipped: LayerRole[] = [];
    // Compose's verdict on the nose's source part when its core was a speck,
    // for the report; otherwise the report judges the composed nose layer.
    let noseSpeck: NoseSpeck | undefined;
    for (const role of ORDER) {
      // A lower lash is placed by its eye's layout, on the sclera's frame.
      const lower = role === "lash_lower_L" || role === "lash_lower_R";
      const key: Role = lower ? LOWER_LASH[role] : role;
      if (lower && split.lashLower === null) {
        skipped.push(role);
        continue;
      }
      const cfg = lower ? { ...layout[key], src: LOWER_LASH_SRC } : layout[key];
      const inMemory = splitSources.get(cfg.src);
      const part = await partBuffer(
        role,
        cfg,
        partsDir,
        inMemory,
        // The split halves are cut from eyewhite.png, the file a caller names.
        mirrored.has(inMemory === undefined ? cfg.src : EYEWHITE_SRC),
      );
      // A lower lid too faint for the alpha the rig reads coverage at, or
      // that the resize erased, would be a layer it refuses as empty.
      if (part === null || (lower && !(await hasCoverage(part.buf)))) {
        skipped.push(role);
        continue;
      }
      // The nose is placed by the box it was sized by. A whole part that stood
      // in is placed by the resized part's own bounds. A core is measured
      // again on the resized part rather than scaled, since resampling moves
      // its edges and the tip rule lands its exact bottom row — and is not
      // judged again here: the source part's verdict decided how it was sized.
      let left: number;
      let top: number;
      if (key === "nose") {
        noseSpeck = part.nose?.speck;
        const { core, bounds } = await coreAndBoundsOf(part.buf);
        const box = part.nose?.whole ? bounds : (core ?? bounds);
        ({ left, top } = nosePlacement(layout, box, part.w, part.h));
      } else {
        ({ left, top } = placement(key, layout[key], part.w, part.h));
      }
      // The eye pair's halves are cut from one eyewhite into one frame. Set
      // apart, the blink fold tears — and a lash narrowed inside its sclera
      // still lies on it and inks its top row, so nothing in the composed
      // layers would show it. Compared as placed, not as set: an h equal to
      // the one the aspect gives lands on the same frame as leaving it unset.
      if (role === "lash_L" || role === "lash_R") {
        const eyeRole = role === "lash_L" ? "eye_L" : "eye_R";
        const eye = placed.find((p) => p.role === eyeRole);
        if (
          eye !== undefined &&
          (eye.left !== left ||
            eye.top !== top ||
            eye.part.w !== part.w ||
            eye.part.h !== part.h)
        ) {
          throw new AutoRigInputError(
            `layout.${role} places the lash at ${part.w}x${part.h} (${left},${top}), but layout.${eyeRole} ` +
              `places its sclera at ${eye.part.w}x${eye.part.h} (${eye.left},${eye.top}) — they are cut from one ` +
              `eyewhite into one frame, and the blink fold tears where they part. Set cx/cy/w/h the same on both.`,
          );
        }
      }
      placed.push({ role, part, left, top });
    }

    // Drop each skipped role's layer from an earlier compose into the same
    // dir: left behind it would contradict `skipped`, since measureDir globs
    // the directory (the report would still show a body) and the next
    // auto_rig_from_layers would rig the stale file into the model. Only the
    // fixed ORDER role names, under the confined outDir, are ever removed.
    for (const role of skipped) {
      fs.rmSync(path.join(outDir, `${role}.png`), { force: true });
    }
    const layers: ComposedLayer[] = [];
    const preview: { input: Buffer; left: number; top: number }[] = [];
    for (const { role, part, left, top } of placed) {
      // role layer: this part alone on a full canvas at its position.
      const layer = await blankCanvas()
        .composite([{ input: part.buf, left, top }])
        .png()
        .toBuffer();
      const outPath = path.join(outDir, `${role}.png`);
      writeFileAtomic(outPath, layer);
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
      measure: await measureDir(outDir, noseSpeck),
    };
  } catch (err) {
    if (err instanceof AutoRigInputError)
      return { ok: false, error: err.message };
    throw err;
  }
}
