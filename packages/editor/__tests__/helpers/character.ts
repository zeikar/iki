/**
 * A synthetic character as `createLayerSetMeasurer` would hand it to the
 * generator: layer boxes on a 1000 × 1000 canvas in the proportions of a
 * composed anime bust (egg-shaped face with ears and a neck, eyes with irises
 * and lashes, brows, a shaded nose, closed and open mouths, bangs framing the
 * face with side strands, back hair, a torso), plus the head edges and iris
 * strands the measurer derives. No pixels: the generator reads geometry only.
 */
import type {
  GenerateOptions,
  IrisStrand,
  LayerInput,
} from "../../src/auto-rig/types";
import { lipSet } from "./lips";

export const CANVAS = { width: 1000, height: 1000 };

type Box = { x: number; y: number; w: number; h: number };

function layer(
  role: string,
  bbox: Box,
  extra: Partial<LayerInput> = {},
): LayerInput {
  return {
    role,
    fileName: `${role}.png`,
    canvasW: CANVAS.width,
    canvasH: CANVAS.height,
    bbox,
    cropW: bbox.w,
    cropH: bbox.h,
    ...extra,
  };
}

/** The face plate's painted half-width per crop row: a skull widening to the
 *  ears at mid-height, a jaw tapering to a neck, and the neck's cut edge. */
function faceRows(h: number): number[] {
  const rows: number[] = [];
  for (let r = 0; r < h; r++) {
    const t = r / h;
    let w: number;
    if (t < 0.5) w = 110 + 88 * Math.sin((t / 0.5) * (Math.PI / 2));
    else if (t < 0.8) w = 198 - (198 - 78) * ((t - 0.5) / 0.3);
    else w = 78;
    if (r >= h - 4) w = 50;
    rows.push(Math.round(w * 2) / 2);
  }
  return rows;
}

export interface CharacterOptions {
  /** The mouth is the folding lip set (`lipSet`) instead of `mouth` and
   *  `mouth_open`. */
  lips?: boolean;
  nose?: boolean;
  hair?: boolean;
  /** Bangs as a fringe spanning the face instead of side strands. */
  fringe?: boolean;
  /** Bangs cut short: a fringe over the forehead only, the back hair
   *  drawing the head's outline. */
  shortFringe?: boolean;
  /** The optional eye and cheek roles: pupils, highlights, blush. */
  extras?: boolean;
  /** A back hair drawn wide behind the bangs — ±310 at the eye row, the
   *  silhouette — and both hair layers carrying their opaque runs, banded
   *  as `FULL_BACK_ROWS` sets out; the face carries its runs too. */
  fullBack?: boolean;
  /** As `fullBack`, but the back hair is solid at ±320 over the crown and
   *  temple bands (58 px past the bangs' widest), so it backs the crown down
   *  to the plate by more than its whole ride asks: about 1.31 × the front
   *  hair's 41 px motion against the back hair (54 px), since the bound
   *  charges a crown vertex row with today's blend down to the row under
   *  it. */
  wideBack?: boolean;
  /** As `wideBack`, but on the crown band the bangs are a dome inside the
   *  eyes' outer corners — half-width 100 on row 10, widening 0.3 px per row
   *  to 160 on row 210 — over a back-hair dome painted 45 px past the bangs'
   *  edge on every row from row 0 to 179: looking up, a row's edge meets
   *  back rows that reach about 37 px past it. From row 180 the back is
   *  solid ±320 into the temple, so the temple's rows, looking up, meet back
   *  hair past their edges. */
  narrowCap?: boolean;
  /** As `fullBack`, but on the solid band (the eye rows, below the cap) each
   *  lock's outer edge sits at ±200 (canvas columns 300 and 701), 30 px past
   *  the eyes' outer corners, over back hair solid out to 2 px past them. */
  tightLock?: boolean;
  /** As `wideBack`, plus a parting both layers draw on rows 30–60: a 6 px
   *  gap in the bangs at the axis (columns 497–502) over a 40 px hole in the
   *  back hair (columns 480–519). */
  crownGap?: boolean;
  /** As `wideBack`, plus the same 6 px gap in the bangs on rows 200–215,
   *  just under the plate's top (row 200): the back hair is solid behind it,
   *  but the face (±110 there) lies in front of the back hair. */
  faceGap?: boolean;
  /** As `wideBack`, plus a 6 px gap in the bangs, columns 632–637, on rows
   *  200–215: at least 9 px outside the face's runs on every row the turn's
   *  check reads there (the face's right end is 610–623 on rows 200–225). */
  besideFaceGap?: boolean;
  /** As `wideBack`, plus the same 6 px gap at the axis on rows 197–199, just
   *  above the plate's top: looking down, the bangs there drop as far as the
   *  face's top, the gap just above it. */
  plateTopGap?: boolean;
  /** As `fullBack`, but on the crown the back hair reaches above the bangs'
   *  top only over a ±15 px band of columns at the axis; elsewhere its top
   *  lies 40 px (0.15 hh) under the bangs' top in each column. */
  tuft?: boolean;
  /** As `fullBack`, but the back hair's top dips 4 px under the bangs' top
   *  (row 10) over a ±15 px band of columns at the axis, as at a parting:
   *  less than the back hair's own nod (4.7 px), so it binds the cap's
   *  slide only through the back hair's posed place, its nod lower. */
  dip?: boolean;
  /** As `fullBack`, but over columns 255–285, on the dome's shoulder, the
   *  back hair's top lies 4 px under the bangs' top in each column — rows
   *  29–68, where the crown already takes 5–24 % of the bangs' nod, which
   *  bares all but two rows of it at the back hair's own slide, within the
   *  0.01 hh budget. */
  shoulderDip?: boolean;
}

/**
 * The `fullBack` hair's bands, canvas rows `[from, to)` (the axis is at
 * column 500.5; the bangs' side locks' outer edges at columns 238 and 762,
 * model ∓262):
 * - `crown`: the back solid ±310 from row 0, above the bangs' top (row 10)
 *   in every column; the bangs a dome widening to ±262;
 * - `temple`: the back's outer end 5 px inside the bangs' edge;
 * - under `wideBack` and the gaps built on it, the back solid ±320 over
 *   both `crown` and `temple`;
 * - under `narrowCap`, `temple` as `wideBack`'s, and on `crown` the bangs a
 *   dome ±100 on row 10 widening 0.3 px per row (±160 by row 210), the back
 *   a dome 45 px wider from row 0 to 179, then solid ±320;
 * - `solid`: from the brows down, the eye row (433.5) among them: the back
 *   one solid run ±310 behind the locks (as it is below the bangs' crop);
 *   under `tightLock`, the locks' outer edges at ±200 (columns 300 and 701)
 *   and the back solid 2 px past them;
 * - `gap`: as on bob's row 366, a 3 px sliver of back 2 px outside the
 *   bangs' edge, then nothing until 8 px inside it;
 * - `stroke`: as on the hero's row 610, the back solid from inside the
 *   bangs' edge to 20 px past it, then empty for 30 px, then a 4 px stroke.
 */
const FULL_BACK_ROWS = {
  crown: [0, 210],
  temple: [210, 330],
  solid: [330, 630],
  gap: [630, 730],
  stroke: [730, 970],
} as const;

/** The `fullBack` layers' `rowRuns`, one entry per crop row: the bangs'
 *  crop holds canvas rows 10–969, the back's rows 0–999. The back's crown is
 *  as `crown` names: `fullBack`'s, or the `tuft`, `dip` or `shoulderDip`
 *  option's; `wide`, `crownGap`, `faceGap`, `besideFaceGap`, `plateTopGap`
 *  and `narrowCap` are the `wideBack` option's and those built on it;
 *  `tightLock` is `fullBack`'s crown over its own solid band. */
function fullBackRuns(
  crown:
    | "full"
    | "tuft"
    | "dip"
    | "shoulder"
    | "wide"
    | "crownGap"
    | "faceGap"
    | "besideFaceGap"
    | "plateTopGap"
    | "narrowCap"
    | "tightLock",
): {
  front: number[][];
  back: number[][];
} {
  const { temple, solid, gap, stroke } = FULL_BACK_ROWS;
  const wide =
    crown === "wide" ||
    crown === "crownGap" ||
    crown === "faceGap" ||
    crown === "besideFaceGap" ||
    crown === "plateTopGap" ||
    crown === "narrowCap";
  // The bangs' dome: its half-width on row k, from ±200 on its top row (10)
  // to ±262 on row 90 and below.
  const dome = (k: number) =>
    Math.round(Math.min(262, 200 + ((k - 10) * 62) / 80));
  const TUFT_DROP = 40;
  const front: number[][] = [];
  const back: number[][] = [];
  for (let k = 0; k < 1000; k++) {
    // The solid band's, unless another band's.
    let f = [238, 347, 654, 762];
    let b = [190, 810];
    if (k < temple[0]) {
      const w = dome(k);
      f = [500 - w, 500 + w];
      if (crown === "tuft") {
        // The back's row k paints the columns of the bangs' row
        // k − TUFT_DROP, and those beside the bangs from TUFT_DROP rows
        // under their widest row (90), so from row 130; the tuft, columns
        // 485–515, from row 0.
        const v = dome(k - TUFT_DROP);
        if (k - TUFT_DROP < 10) b = [485, 516];
        else if (v < 262) b = [500 - v, 500 + v];
      } else if (crown === "dip" && k < 14) {
        b = [190, 485, 516, 810];
      } else if (crown === "shoulder") {
        // The band's columns the bangs' row k − 4 does not reach.
        const end = Math.min(286, 500 - dome(k - 4));
        if (end > 255) b = [190, 255, end, 810];
      }
    } else if (k < temple[1]) {
      f = [238, 762];
      b = [243, 757];
    } else if (k >= gap[0] && k < gap[1]) {
      b = [233, 236, 246, 754, 764, 767];
    } else if (k >= stroke[0] && k < stroke[1]) {
      b = [184, 188, 218, 782, 812, 816];
    } else if (crown === "tightLock" && k >= solid[0] && k < solid[1]) {
      f = [300, 347, 654, 701];
      b = [298, 703];
    }
    if (wide && k < temple[1]) b = [180, 820];
    if (crown === "narrowCap" && k < temple[0]) {
      // The bangs' dome, inside the eyes' outer corners, and the back's
      // dome 45 px wider on every row from row 0 to 179 (then wideBack's).
      const w = Math.round(100 + 0.3 * (k - 10));
      f = [500 - w, 500 + w];
      if (k < 180) b = [500 - w - 45, 500 + w + 45];
    }
    // A gap in the bangs, inside their outer ends.
    if (crown === "crownGap" && k >= 30 && k <= 60) {
      f = [f[0], 497, 503, f[1]];
      b = [180, 480, 520, 820];
    } else if (crown === "faceGap" && k >= 200 && k <= 215) {
      f = [f[0], 497, 503, f[1]];
    } else if (crown === "besideFaceGap" && k >= 200 && k <= 215) {
      f = [f[0], 632, 638, f[1]];
    } else if (crown === "plateTopGap" && k >= 197 && k <= 199) {
      f = [f[0], 497, 503, f[1]];
    }
    if (k >= 10 && k < 970) front.push(f);
    back.push(b);
  }
  return { front, back };
}

export function character(opts: CharacterOptions = {}): {
  layers: LayerInput[];
  options: GenerateOptions;
} {
  const {
    lips = false,
    nose = true,
    hair = true,
    fringe = false,
    shortFringe = false,
    extras = false,
    tuft = false,
    dip = false,
    shoulderDip = false,
    wideBack = false,
    crownGap = false,
    faceGap = false,
    besideFaceGap = false,
    plateTopGap = false,
    narrowCap = false,
    tightLock = false,
  } = opts;
  // The `fullBack` variant an option names, if any.
  const variant = (
    [
      ["tuft", tuft],
      ["dip", dip],
      ["shoulder", shoulderDip],
      ["wide", wideBack],
      ["crownGap", crownGap],
      ["faceGap", faceGap],
      ["besideFaceGap", besideFaceGap],
      ["plateTopGap", plateTopGap],
      ["narrowCap", narrowCap],
      ["tightLock", tightLock],
    ] as const
  ).find(([, on]) => on)?.[0];
  const fullBack = opts.fullBack === true || variant !== undefined;
  const face = { x: 300, y: 200, w: 401, h: 560 };
  const halfWidths = faceRows(face.h);
  const layers: LayerInput[] = [
    layer("body", { x: 90, y: 770, w: 820, h: 230 }),
    layer("face", face, {
      rowHalfWidths: halfWidths,
      // As the measurer records them: one whole-pixel run per row, twice its
      // half-width wide, from the axis (canvas column 500.5) less the
      // half-width rounded down — centred on the axis for a half-integer
      // half-width, on column 500 for an integer one.
      ...(fullBack
        ? {
            rowRuns: halfWidths.map((w) => {
              const a = Math.floor(face.x + face.w / 2 - w);
              return [a, a + 2 * w];
            }),
          }
        : {}),
    }),
    layer("eye_R", { x: 330, y: 400, w: 130, h: 66 }),
    layer("eye_L", { x: 541, y: 400, w: 130, h: 66 }),
    layer("iris_R", { x: 358, y: 396, w: 74, h: 74 }),
    layer("iris_L", { x: 569, y: 396, w: 74, h: 74 }),
    layer("lash_R", { x: 330, y: 400, w: 130, h: 35 }),
    layer("lash_L", { x: 541, y: 400, w: 130, h: 35 }),
    layer("brow_R", { x: 340, y: 350, w: 137, h: 23 }),
    layer("brow_L", { x: 524, y: 350, w: 137, h: 23 }),
    ...(lips
      ? lipSet()
      : [
          layer("mouth", { x: 465, y: 590, w: 70, h: 21 }),
          layer("mouth_open", { x: 465, y: 588, w: 70, h: 29 }),
        ]),
  ];
  if (nose) {
    layers.push(
      layer(
        "nose",
        { x: 473, y: 500, w: 54, h: 83 },
        { denseCore: { x: 480, y: 512, w: 39, h: 63 } },
      ),
    );
  }
  if (extras) {
    layers.push(
      layer("pupil_R", { x: 382, y: 420, w: 26, h: 26 }),
      layer("pupil_L", { x: 593, y: 420, w: 26, h: 26 }),
      layer("highlight_R", { x: 400, y: 410, w: 14, h: 14 }),
      layer("highlight_L", { x: 611, y: 410, w: 14, h: 14 }),
      layer("blush_R", { x: 330, y: 500, w: 80, h: 40 }),
      layer("blush_L", { x: 591, y: 500, w: 80, h: 40 }),
    );
  }
  if (hair && shortFringe) {
    layers.push(
      layer("hair_back", { x: 110, y: 20, w: 780, h: 980 }),
      layer("hair_front", { x: 380, y: 150, w: 241, h: 180 }),
    );
    // The back hair draws the outline at the eye row; the fringe stops
    // above the eyes, so no strand crosses an iris's row.
    return {
      layers,
      options: {
        turnTargets: { headHalfWidth: 230 },
        headEdges: {
          left: [
            { role: "hair_back", x: -230 },
            { role: "face", x: -200 },
          ],
          right: [
            { role: "hair_back", x: 229 },
            { role: "face", x: 200 },
          ],
        },
      },
    };
  }
  if (hair) {
    const runs = fullBack ? fullBackRuns(variant ?? "full") : undefined;
    layers.push(
      runs
        ? layer(
            "hair_back",
            { x: 90, y: 0, w: 820, h: 1000 },
            { rowRuns: runs.back },
          )
        : layer("hair_back", { x: 110, y: 20, w: 780, h: 980 }),
      layer(
        "hair_front",
        { x: 170, y: 10, w: 660, h: 960 },
        runs ? { rowRuns: runs.front } : {},
      ),
    );
  }
  const options: GenerateOptions = {};
  if (hair) {
    // The bangs draw the head's outline at the eye row, ±262 about the face —
    // unless the full back hair, at ±310, draws it.
    const back = fullBack ? 310 : 230;
    options.turnTargets = { headHalfWidth: fullBack ? 310 : 262 };
    options.headEdges = {
      left: [
        { role: "hair_front", x: -262 },
        { role: "hair_back", x: -back },
        { role: "face", x: -200 },
      ],
      right: [
        { role: "hair_front", x: 261 },
        { role: "hair_back", x: back - 1 },
        { role: "face", x: 200 },
      ],
    };
    const y = 500 - 433.5;
    const left: IrisStrand = fringe
      ? { y, irisOuter: -142, irisInner: -68, runOuter: -240, runFace: null }
      : { y, irisOuter: -142, irisInner: -68, runOuter: -226, runFace: -153 };
    const right: IrisStrand = fringe
      ? { y, irisOuter: 143, irisInner: 69, runOuter: 241, runFace: null }
      : { y, irisOuter: 143, irisInner: 69, runOuter: 227, runFace: 154 };
    options.strandEdges = { left, right };
  }
  return { layers, options };
}
