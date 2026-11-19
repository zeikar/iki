/**
 * The landmarks one finished picture is cut by: where its features sit, the
 * outlines that split its hair, and the points its colours and floods start
 * from, all read off `view_illustration_grid` by an agent.
 *
 * A generator input, not part of the `.iki` contract. `validateLandmarks` is
 * the authoritative check for every caller: it refuses with an
 * `AutoRigInputError` whose message starts at the offending path
 * (`landmarks.eyes.L.iris.rx ...`) and returns the landmarks with every
 * default filled in.
 *
 * Frame: canvas px, origin top-left, x right, y down; a point names a pixel.
 * `L` is the character's left, the viewer's right.
 */

import { partIdsOfRole } from "@ikijs/editor";
import { ARM_ROLES } from "./measure-arms";
import type { Box, CanvasSize, Point } from "./illustration";
import {
  AutoRigInputError,
  MAX_LANDMARK_BODY_ONLY,
  MAX_LANDMARK_CUSTOM_PARTS,
  MAX_LANDMARK_POINTS,
  MAX_LANDMARK_SAMPLES,
} from "./limits";

/** Where the colour classes come from: each point reads a small patch, and a
 *  pixel is hair or skin by which set it is nearer. A missing tone leaves
 *  paint in it unclassed or on the wrong side. */
export interface IllustrationSamples {
  hair: {
    /** On the hair's main colour, spread over the head; a point on skin or
     *  ink makes the face read as hair. */
    base: Point[];
    /** On the hair's shadowed parts; without them shaded strands can fall to
     *  the skin. */
    shadow?: Point[];
    /** On the hair's sheen; without them a bright band can read as neither. */
    highlight?: Point[];
  };
  skin: {
    /** On lit skin (cheeks, forehead); a point on hair or a blush makes the
     *  face and the hair swap paint. */
    base: Point[];
    /** On shaded skin (under the bangs, the neck); without them shaded skin
     *  can fall to the hair. */
    shadow?: Point[];
  };
}

export interface IllustrationEye {
  /** The whole drawn eye, lashes included; a box that clips the eye leaves
   *  the clipped paint on the face. */
  box: Box;
  /** The iris disc, its centre inside `box`; an ellipse wider than the disc
   *  pulls sclera or lash into the iris. */
  iris: { cx: number; cy: number; rx: number; ry: number };
}

export interface IllustrationBrow {
  /** The brow's centreline, tail first, 2 or more points; a line off the
   *  brow leaves part of it on the face. */
  line: Point[];
  /** Half-width of the band around `line` the brow is cut from (8 when
   *  omitted); too narrow leaves the brow's edge behind, too wide takes hair
   *  or lash. */
  halfWidth: number;
  /** The band's half-width at the tail, where the brow thins (5 when
   *  omitted); too wide takes the hair beside the tail. */
  tailHalfWidth: number;
}

/** A custom part's cut: the back hair inside a polygon. */
export interface IllustrationPolygonCut {
  /** The part's id, also its layer's file name: a plain identifier that no
   *  role takes. */
  id: string;
  /** Where the part hangs from the head (a tail's knot); the part swings
   *  about it, so a tie off the root tears the part away from the head as it
   *  swings. */
  tie: Point;
  /** Everything of the back hair inside it goes to the part; a polygon that
   *  misses a strand leaves it in the back hair, where it widens the head
   *  the turn is fitted to. */
  polygon: Point[];
}

/** A custom part's cut: the back hair on one side of a boundary line. */
export interface IllustrationSideCut {
  /** The part's id, also its layer's file name: a plain identifier that no
   *  role takes. */
  id: string;
  /** Where the part hangs from the head (a tail's knot); the part swings
   *  about it, so a tie off the root tears the part away from the head as it
   *  swings. */
  tie: Point;
  /** Which side of `line` the part lies on, as the viewer sees it: `left`
   *  takes the hair at smaller x. The wrong side takes the head's hair. */
  side: "left" | "right";
  /** Where the part leaves the head's hair, top to bottom (y strictly
   *  ascending), 2 or more points; a line inside the part leaves its root in
   *  the back hair. */
  line: Point[];
  /** Under the line's last point, the part is everything on its side of the
   *  column x = `below`; set it between the part and the body's hair. */
  below: number;
  /** A box around a ribbon or tie: its strongly coloured paint that is not
   *  hair goes with the part instead of staying in the back hair. */
  ribbonBox?: Box;
}

export type IllustrationCustomCut =
  | IllustrationPolygonCut
  | IllustrationSideCut;

/** The landmarks with every default applied. */
export interface IllustrationLandmarks {
  /** Colour samples for hair and skin; a sample on the wrong paint moves
   *  that paint to the other class across the whole picture. */
  samples: IllustrationSamples;
  /** `L` is the character's left eye, on the viewer's right; a swapped pair
   *  rigs each eye with the other side's motion. */
  eyes: { L: IllustrationEye; R: IllustrationEye };
  /** Each side optional; a brow left out stays painted on the face and
   *  never moves. */
  brows?: { L?: IllustrationBrow; R?: IllustrationBrow };
  /** The drawn nose; left out, it stays on the face. A box that clips it
   *  leaves the clipped paint on the face. */
  nose?: { box: Box };
  mouth: {
    /** The whole drawn mouth; a box that clips it leaves paint on the face. */
    box: Box;
    /** The viewer's left end of the drawn mouth line; the lip set's corners
     *  land on the two corners, so a corner off the line skews the mouth. */
    cornerL: Point;
    /** The viewer's right end of the drawn mouth line. */
    cornerR: Point;
  };
  /** Polygon, 3 or more points: the bangs and the strands beside the face.
   *  Wider than the face, the turn is clamped; narrower, the bangs' edge
   *  stays in the back hair. */
  frontHair: Point[];
  /** Polygons, 3 or more points each, round a lock that hangs from under
   *  the bangs in front of the ear and the cheek's edge, each side optional
   *  (`L` the character's left, on the viewer's right): its hair is
   *  `hair_side_<side>`, drawn over the face and under `hair_front`, and
   *  rigged to ride the face. Trace the lock's outline from up inside
   *  `frontHair` (the two may overlap: the front hair keeps the paint both
   *  claim) down round its tip. The lock's root is carried up under the
   *  bangs. Under the lock, skin is filled only where it crosses the face's
   *  own paint (the ear on one side and the cheek on the other) and inside
   *  `skull`; the back hair is filled under it down to `shellLower`, so lower
   *  `shellLower` at that side to where the hair behind the lock ends. A top
   *  below the front hair leaves a strip of the lock in the back hair and
   *  its root showing; a polygon reaching over the eye's outer corner puts it under
   *  the lock at rest; one wider than the lock takes the back hair beside
   *  it, which then rides the face. */
  sideHair?: { L?: Point[]; R?: Point[] };
  /** Polygon, 3 or more points: the head's skin, the part hidden under the
   *  hair included, the ears not; skin is filled in under the bangs and the
   *  side locks inside it, so too small shows hair through the forehead on
   *  a turn, and one out over an ear lays skin where hair is behind a
   *  lock. */
  skull: Point[];
  /** The back hair's lower edge behind the face, left to right (x strictly
   *  ascending), 2 or more points; hair is filled in behind the face down to
   *  it, so too high shows a gap under the jaw on a turn. */
  shellLower: Point[];
  /** 1 or more, on the face's skin: cheeks, forehead, and one on each ear;
   *  skin no seed reaches stays out of the face. */
  skinSeeds: Point[];
  /** 1 or more, on the neck and the chest; paint no seed reaches stays out
   *  of the body. */
  bodySeeds: Point[];
  /** Backdrop pockets the figure encloses, which the flood from the border
   *  cannot reach; a pocket without one stays painted. Pockets the hair
   *  rings (gaps between strands) are keyed without one. Empty when
   *  omitted. */
  backgroundSeeds: Point[];
  /** Backdrop-coloured paint the hair rings that is paint, not backdrop (a
   *  pale clip between two locks): a pocket holding one is never keyed on
   *  its own. Empty when omitted. */
  paintSeeds: Point[];
  /** The row the neck is carried up to behind the chin; too low shows a gap
   *  under the jaw when the head turns or nods. */
  neckTopY: number;
  /** Polygons, 3 or more points each, where paint the colour samples call
   *  hair belongs to the body: a dark jacket under near-black hair, a
   *  hair-coloured bow on the chest. Without one such paint is cut into the
   *  hair layers; one over the hair takes it out of them. Empty when
   *  omitted. */
  bodyOnly: Point[][];
  /** Parts cut out of the back hair (tails, a ponytail); empty when omitted.
   *  A part left in the back hair widens the head the turn is fitted to. */
  customParts: IllustrationCustomCut[];
}

const DEFAULT_BROW_HALF_WIDTH = 8;
const DEFAULT_BROW_TAIL_HALF_WIDTH = 5;

const KEYS = {
  root: [
    "samples",
    "eyes",
    "brows",
    "nose",
    "mouth",
    "frontHair",
    "sideHair",
    "skull",
    "shellLower",
    "skinSeeds",
    "bodySeeds",
    "backgroundSeeds",
    "paintSeeds",
    "neckTopY",
    "bodyOnly",
    "customParts",
  ],
  samples: ["hair", "skin"],
  hair: ["base", "shadow", "highlight"],
  skin: ["base", "shadow"],
  sides: ["L", "R"],
  eye: ["box", "iris"],
  iris: ["cx", "cy", "rx", "ry"],
  brow: ["line", "halfWidth", "tailHalfWidth"],
  nose: ["box"],
  mouth: ["box", "cornerL", "cornerR"],
  custom: ["id", "tie", "polygon", "side", "line", "below", "ribbonBox"],
} as const;

/** The keys of a side cut beyond `id` and `tie`. */
const SIDE_CUT_KEYS = ["side", "line", "below", "ribbonBox"] as const;

/** The custom-part id rule of `@ikijs/editor`'s `checkCustomParts`
 *  (`auto-rig/custom-parts.ts`), which does not export it: mirrored so the
 *  cut and the rig tell a user one rule. */
const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const fail = (message: string): never => {
  throw new AutoRigInputError(message);
};

/** A value as a message quotes it. A BigInt is written out by hand: JSON
 *  has none, and `JSON.stringify` throws on one. */
const show = (v: unknown): string =>
  typeof v === "bigint"
    ? `${v}n`
    : (JSON.stringify(v, (_key, x: unknown) =>
        typeof x === "bigint" ? `${x}n` : x,
      ) ?? String(v));

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** `v` is an array of `n` finite numbers. Read by index: `every` skips the
 *  holes of a sparse array. */
function finiteTuple(v: unknown, n: number): v is number[] {
  if (!Array.isArray(v) || v.length !== n) return false;
  for (let i = 0; i < n; i++) if (!finite(v[i])) return false;
  return true;
}

/** An object whose keys are all among `known`. */
function object(
  path: string,
  v: unknown,
  known: readonly string[],
): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return fail(`${path} must be a plain object, got ${show(v)}`);
  }
  for (const key of Object.keys(v)) {
    if (!known.includes(key)) {
      fail(`${path}.${key} is not one of ${known.join(", ")}`);
    }
  }
  return v as Record<string, unknown>;
}

function required(
  path: string,
  o: Record<string, unknown>,
  key: string,
): unknown {
  const v = o[key];
  return v === undefined ? fail(`${path}.${key} is missing`) : v;
}

function number(path: string, v: unknown): number {
  return finite(v)
    ? v
    : fail(`${path} must be a finite number, got ${show(v)}`);
}

function positive(path: string, v: unknown): number {
  return finite(v) && v > 0
    ? v
    : fail(`${path} must be a positive number, got ${show(v)}`);
}

function canvasBounds({ width, height }: CanvasSize): string {
  return `the ${width}x${height} canvas (0 <= x < ${width}, 0 <= y < ${height})`;
}

function point(path: string, v: unknown, canvas: CanvasSize): Point {
  if (!finiteTuple(v, 2)) {
    return fail(
      `${path} must be an [x, y] pair of finite numbers, got ${show(v)}`,
    );
  }
  const [x, y] = v;
  if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) {
    fail(`${path} ${show(v)} is outside ${canvasBounds(canvas)}`);
  }
  return [x, y];
}

function points(
  path: string,
  v: unknown,
  min: number,
  canvas: CanvasSize,
): Point[] {
  if (!Array.isArray(v)) {
    return fail(`${path} must be an array of [x, y] points, got ${show(v)}`);
  }
  if (v.length < min) {
    fail(
      `${path} must have ${min} or more point${min > 1 ? "s" : ""}, got ${v.length}`,
    );
  }
  if (v.length > MAX_LANDMARK_POINTS) {
    fail(
      `${path} has ${v.length} points, over the ${MAX_LANDMARK_POINTS} a landmark list may hold`,
    );
  }
  // By index, so a hole in a sparse array is refused rather than skipped.
  const out: Point[] = [];
  for (let i = 0; i < v.length; i++) {
    out.push(point(`${path}[${i}]`, v[i], canvas));
  }
  return out;
}

function box(path: string, v: unknown, canvas: CanvasSize): Box {
  if (!finiteTuple(v, 4)) {
    return fail(
      `${path} must be [x0, y0, x1, y1], four finite numbers, got ${show(v)}`,
    );
  }
  const [x0, y0, x1, y1] = v;
  if (!(x1 > x0 && y1 > y0)) {
    fail(
      `${path} ${show(v)} must span at least two columns and two rows, x1 > x0 and y1 > y0: both corners are inside the box`,
    );
  }
  if (x0 < 0 || y0 < 0 || x1 >= canvas.width || y1 >= canvas.height) {
    fail(`${path} ${show(v)} reaches outside ${canvasBounds(canvas)}`);
  }
  return [x0, y0, x1, y1];
}

const inBox = ([x0, y0, x1, y1]: Box, x: number, y: number): boolean =>
  x >= x0 && x <= x1 && y >= y0 && y <= y1;

/** Each point's coordinate `axis` greater than the one before it. */
function ascending(path: string, pts: Point[], axis: 0 | 1): void {
  for (let i = 1; i < pts.length; i++) {
    if (!(pts[i][axis] > pts[i - 1][axis])) {
      const name = axis === 0 ? "x" : "y";
      fail(
        `${path}[${i}] ${name} ${pts[i][axis]} must be greater than ${path}[${i - 1}] ${name} ${pts[i - 1][axis]}: the points run with ${name} strictly ascending`,
      );
    }
  }
}

function eye(path: string, v: unknown, canvas: CanvasSize): IllustrationEye {
  const o = object(path, v, KEYS.eye);
  const eyeBox = box(`${path}.box`, required(path, o, "box"), canvas);
  const ip = `${path}.iris`;
  const i = object(ip, required(path, o, "iris"), KEYS.iris);
  const cx = number(`${ip}.cx`, required(ip, i, "cx"));
  const cy = number(`${ip}.cy`, required(ip, i, "cy"));
  const rx = positive(`${ip}.rx`, required(ip, i, "rx"));
  const ry = positive(`${ip}.ry`, required(ip, i, "ry"));
  if (!inBox(eyeBox, cx, cy)) {
    fail(`${ip} centre [${cx}, ${cy}] is outside ${path}.box ${show(eyeBox)}`);
  }
  return { box: eyeBox, iris: { cx, cy, rx, ry } };
}

function brow(path: string, v: unknown, canvas: CanvasSize): IllustrationBrow {
  const o = object(path, v, KEYS.brow);
  return {
    line: points(`${path}.line`, required(path, o, "line"), 2, canvas),
    halfWidth:
      o.halfWidth === undefined
        ? DEFAULT_BROW_HALF_WIDTH
        : positive(`${path}.halfWidth`, o.halfWidth),
    tailHalfWidth:
      o.tailHalfWidth === undefined
        ? DEFAULT_BROW_TAIL_HALF_WIDTH
        : positive(`${path}.tailHalfWidth`, o.tailHalfWidth),
  };
}

/** The part ids a role yields besides its own name: only the arms', in
 *  `ROLE_TABLE` (`@ikijs/editor`'s `auto-rig/roles.ts`), which the package
 *  does not export. */
const YIELDED_PART_IDS = new Set(ARM_ROLES.flatMap((r) => partIdsOfRole(r)));

/** A role's name or a part id a role yields: the rig reserves both for
 *  roles (`RESERVED` in `@ikijs/editor`'s `auto-rig/custom-parts.ts`), so a
 *  custom part named either is refused there. `partIdsOfRole` throws on any
 *  name but a role's. */
function isReservedId(id: string): boolean {
  if (YIELDED_PART_IDS.has(id)) return true;
  try {
    partIdsOfRole(id);
    return true;
  } catch {
    return false;
  }
}

function customCut(
  path: string,
  v: unknown,
  canvas: CanvasSize,
  ids: Set<string>,
): IllustrationCustomCut {
  const o = object(path, v, KEYS.custom);
  const id = required(path, o, "id");
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    fail(
      `${path}.id must be a plain identifier (letters, digits, underscore; not starting with a digit), got ${show(id)}`,
    );
  }
  const name = id as string;
  if (isReservedId(name)) {
    fail(
      `${path}.id "${name}" is a role's name or a part id a role yields: a custom part needs a name no role takes`,
    );
  }
  if (ids.has(name)) {
    fail(`${path}.id "${name}" repeats an earlier entry's id`);
  }
  ids.add(name);
  const tie = point(`${path}.tie`, required(path, o, "tie"), canvas);

  const sideKeys = SIDE_CUT_KEYS.filter((k) => o[k] !== undefined);
  if (o.polygon !== undefined) {
    if (sideKeys.length > 0) {
      fail(
        `${path} carries both polygon and ${sideKeys.join(", ")}: give either polygon, or side, line and below`,
      );
    }
    return {
      id: name,
      tie,
      polygon: points(`${path}.polygon`, o.polygon, 3, canvas),
    };
  }
  if (sideKeys.length === 0) {
    fail(`${path} must carry either polygon, or side, line and below`);
  }
  const side = required(path, o, "side");
  if (side !== "left" && side !== "right") {
    fail(`${path}.side must be "left" or "right", got ${show(side)}`);
  }
  const line = points(`${path}.line`, required(path, o, "line"), 2, canvas);
  ascending(`${path}.line`, line, 1);
  const below = number(`${path}.below`, required(path, o, "below"));
  if (below < 0 || below >= canvas.width) {
    fail(
      `${path}.below ${below} must be a column of the canvas, 0 <= x < ${canvas.width}`,
    );
  }
  const cut: IllustrationSideCut = {
    id: name,
    tie,
    side: side as "left" | "right",
    line,
    below,
  };
  if (o.ribbonBox !== undefined) {
    cut.ribbonBox = box(`${path}.ribbonBox`, o.ribbonBox, canvas);
  }
  return cut;
}

/**
 * Check `input` against the landmarks schema on a `canvas`-sized picture and
 * return it with the defaults applied. Throws `AutoRigInputError` at the
 * first fault, its message starting at that field's path.
 */
export function validateLandmarks(
  input: unknown,
  canvas: CanvasSize,
): IllustrationLandmarks {
  const at = "landmarks";
  const root = object(at, input, KEYS.root);

  const sp = `${at}.samples`;
  const s = object(sp, required(at, root, "samples"), KEYS.samples);
  const hp = `${sp}.hair`;
  const h = object(hp, required(sp, s, "hair"), KEYS.hair);
  const kp = `${sp}.skin`;
  const k = object(kp, required(sp, s, "skin"), KEYS.skin);
  const samples: IllustrationSamples = {
    hair: { base: points(`${hp}.base`, required(hp, h, "base"), 1, canvas) },
    skin: { base: points(`${kp}.base`, required(kp, k, "base"), 1, canvas) },
  };
  if (h.shadow !== undefined) {
    samples.hair.shadow = points(`${hp}.shadow`, h.shadow, 1, canvas);
  }
  if (h.highlight !== undefined) {
    samples.hair.highlight = points(`${hp}.highlight`, h.highlight, 1, canvas);
  }
  if (k.shadow !== undefined) {
    samples.skin.shadow = points(`${kp}.shadow`, k.shadow, 1, canvas);
  }
  for (const [path, set] of [
    [hp, samples.hair],
    [kp, samples.skin],
  ] as const) {
    const total = Object.values(set).reduce((t, list) => t + list.length, 0);
    if (total > MAX_LANDMARK_SAMPLES) {
      fail(
        `${path} has ${total} points, over the ${MAX_LANDMARK_SAMPLES} one set may hold: a few per tone describe it`,
      );
    }
  }

  const ep = `${at}.eyes`;
  const e = object(ep, required(at, root, "eyes"), KEYS.sides);
  const eyes = {
    L: eye(`${ep}.L`, required(ep, e, "L"), canvas),
    R: eye(`${ep}.R`, required(ep, e, "R"), canvas),
  };
  const centreX = ([x0, , x1]: Box) => (x0 + x1) / 2;
  if (!(centreX(eyes.L.box) > centreX(eyes.R.box))) {
    fail(
      `${ep}.L.box centre x ${centreX(eyes.L.box)} is not right of ${ep}.R.box centre x ${centreX(eyes.R.box)}: L is the character's left eye, on the viewer's right, so the two look swapped`,
    );
  }

  let brows: IllustrationLandmarks["brows"];
  if (root.brows !== undefined) {
    const bp = `${at}.brows`;
    const b = object(bp, root.brows, KEYS.sides);
    brows = {};
    if (b.L !== undefined) brows.L = brow(`${bp}.L`, b.L, canvas);
    if (b.R !== undefined) brows.R = brow(`${bp}.R`, b.R, canvas);
  }

  let nose: IllustrationLandmarks["nose"];
  if (root.nose !== undefined) {
    const np = `${at}.nose`;
    const n = object(np, root.nose, KEYS.nose);
    nose = { box: box(`${np}.box`, required(np, n, "box"), canvas) };
  }

  const mp = `${at}.mouth`;
  const m = object(mp, required(at, root, "mouth"), KEYS.mouth);
  const mouthBox = box(`${mp}.box`, required(mp, m, "box"), canvas);
  const cornerL = point(`${mp}.cornerL`, required(mp, m, "cornerL"), canvas);
  const cornerR = point(`${mp}.cornerR`, required(mp, m, "cornerR"), canvas);
  if (!(cornerL[0] < cornerR[0])) {
    fail(
      `${mp}.cornerL x ${cornerL[0]} must be left of ${mp}.cornerR x ${cornerR[0]}: cornerL is the viewer's left end of the mouth line`,
    );
  }
  for (const [name, c] of [
    ["cornerL", cornerL],
    ["cornerR", cornerR],
  ] as const) {
    if (!inBox(mouthBox, c[0], c[1])) {
      fail(`${mp}.${name} ${show(c)} is outside ${mp}.box ${show(mouthBox)}`);
    }
  }

  const list = (key: string, min: number): Point[] =>
    points(`${at}.${key}`, required(at, root, key), min, canvas);
  const frontHair = list("frontHair", 3);
  let sideHair: IllustrationLandmarks["sideHair"];
  if (root.sideHair !== undefined) {
    const shp = `${at}.sideHair`;
    const sh = object(shp, root.sideHair, KEYS.sides);
    sideHair = {};
    if (sh.L !== undefined) sideHair.L = points(`${shp}.L`, sh.L, 3, canvas);
    if (sh.R !== undefined) sideHair.R = points(`${shp}.R`, sh.R, 3, canvas);
  }
  const skull = list("skull", 3);
  const shellLower = list("shellLower", 2);
  ascending(`${at}.shellLower`, shellLower, 0);
  const skinSeeds = list("skinSeeds", 1);
  const bodySeeds = list("bodySeeds", 1);
  const backgroundSeeds =
    root.backgroundSeeds === undefined
      ? []
      : points(`${at}.backgroundSeeds`, root.backgroundSeeds, 0, canvas);
  const paintSeeds =
    root.paintSeeds === undefined
      ? []
      : points(`${at}.paintSeeds`, root.paintSeeds, 0, canvas);

  const neckTopY = number(`${at}.neckTopY`, required(at, root, "neckTopY"));
  if (neckTopY < 0 || neckTopY >= canvas.height) {
    fail(
      `${at}.neckTopY ${neckTopY} must be a row of the canvas, 0 <= y < ${canvas.height}`,
    );
  }

  const op = `${at}.bodyOnly`;
  const bodyOnlyInput = root.bodyOnly === undefined ? [] : root.bodyOnly;
  if (!Array.isArray(bodyOnlyInput)) {
    return fail(
      `${op} must be an array of polygons, got ${show(bodyOnlyInput)}`,
    );
  }
  if (bodyOnlyInput.length > MAX_LANDMARK_BODY_ONLY) {
    fail(
      `${op} has ${bodyOnlyInput.length} polygons, over the ${MAX_LANDMARK_BODY_ONLY} one picture may hold`,
    );
  }
  const bodyOnly: Point[][] = [];
  for (let i = 0; i < bodyOnlyInput.length; i++) {
    bodyOnly.push(points(`${op}[${i}]`, bodyOnlyInput[i], 3, canvas));
  }

  const cp = `${at}.customParts`;
  const customInput = root.customParts === undefined ? [] : root.customParts;
  if (!Array.isArray(customInput)) {
    return fail(`${cp} must be an array, got ${show(customInput)}`);
  }
  if (customInput.length > MAX_LANDMARK_CUSTOM_PARTS) {
    fail(
      `${cp} has ${customInput.length} entries, over the ${MAX_LANDMARK_CUSTOM_PARTS} custom parts one picture may cut`,
    );
  }
  const ids = new Set<string>();
  const customParts: IllustrationCustomCut[] = [];
  for (let i = 0; i < customInput.length; i++) {
    customParts.push(customCut(`${cp}[${i}]`, customInput[i], canvas, ids));
  }

  return {
    samples,
    eyes,
    ...(brows && { brows }),
    ...(nose && { nose }),
    mouth: { box: mouthBox, cornerL, cornerR },
    frontHair,
    ...(sideHair && { sideHair }),
    skull,
    shellLower,
    skinSeeds,
    bodySeeds,
    backgroundSeeds,
    paintSeeds,
    neckTopY,
    bodyOnly,
    customParts,
  };
}
