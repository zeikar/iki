/**
 * The head's frame of reference, read off the layers: where its turn axis
 * runs, its eye row and chin (and so the profile's head unit), the face
 * plate's painted rows, the neck the face layer carries and the jaw line that
 * separates the two, and the silhouette the measured head draws.
 */

import { boxOfLayer, clamp, cx, cy, type Box } from "./layout";
import { HH_PER_EYE_TO_CHIN } from "./profile";
import type { HeadEdges, LayerInput } from "./types";

export interface Neck {
  /** Where the jaw's outline meets the neck's sides, model y. */
  topY: number;
  /** The neck's half-width there. */
  half: number;
  /** The widest the neck gets below that (a flare into the collar). */
  span: number;
  /** Its narrowest, between the two: where its outline runs. */
  waist: number;
  /** Under a measured jaw stroke, given the chin's slide: how far from the
   *  axis the cut draws the end of the chin's shade band (see JAW_SHADE). */
  bandEnd?: number;
}

/** Ears the face layer paints on the plate's sides: a band of rows where the
 *  outline juts out past the head's own and back in. */
export interface Ears {
  /** The band's top and bottom rows, model y. */
  top: number;
  bottom: number;
  /** The head's own half-width on row `y` of the band, under the ear. */
  attachAt(y: number): number;
  /** The ears' widest half-width. */
  outer: number;
}

export interface HeadFrame {
  canvasW: number;
  canvasH: number;
  face: Box;
  /** The head's vertical centre line, model x (the face plate's centre). */
  axisX: number;
  /** The eye row (the iris centres), model y. */
  eyeY: number;
  mouthY: number;
  /** The chin tip — the jaw outline's lowest point — model y. */
  chinY: number;
  /** The profile's head unit, px: `HH_PER_EYE_TO_CHIN` × eye row → chin. */
  hh: number;
  /** Half the face plate's painted width on row `y`. */
  paintedHalfAt(y: number): number;
  /** The face plate's widest half-width. */
  wMax: number;
  /** The head's own widest half-width, its ears left out. */
  headMax: number;
  /** Whether the face carried a measured row profile. */
  hasProfile: boolean;
  /** The neck the face layer carries below its jaw, if any. */
  neck?: Neck;
  /** The ears it paints on its sides, if any. */
  ears?: Ears;
  /** The head's lower boundary at column x, model y: just under the jaw's
   *  outline across the neck, just under the plate's own edge elsewhere.
   *  What lies below it (the neck) stays with the body. */
  cutAt(x: number): number;
  /** The rows the plate's width change is read at. */
  cheekY: number;
  jawY: number;
  /** The held silhouette's edges at the eye row, model x. */
  shellLeft: number;
  shellRight: number;
  /** True when a measured head (hair) is wider than the face plate. */
  hairShell: boolean;
  /** The head half-width the turn cues are fractions of. */
  holdBase: number;
  /** A hair layer's opaque runs on the pixel row holding model y, as model x
   *  boundaries `[start0, end0, start1, end1, …]` (its `rowRuns`); `[]` off
   *  its crop, `undefined` when the layer is absent or carries none. */
  hairRuns(role: "hair_front" | "hair_back", y: number): number[] | undefined;
}

/** The outermost edge of `runs` (model x boundaries) on `side` of the axis:
 *  the last run's end on +x, the first run's start on −x; `undefined` when
 *  no run reaches past the axis on that side. */
export function outerEdge(
  runs: number[],
  axisX: number,
  side: -1 | 1,
): number | undefined {
  if (runs.length === 0) return undefined;
  const x = side > 0 ? runs[runs.length - 1] : runs[0];
  return side * (x - axisX) > 0 ? x : undefined;
}

/** How far the run of `runs` holding the pixel just inside boundary `x` on
 *  `side` reaches inward of `x` and outward past it, px; 0 both where that
 *  pixel is transparent. A run beyond a gap does not count. */
export function runReach(
  runs: number[],
  x: number,
  side: -1 | 1,
): { inward: number; outward: number } {
  // The pixel just inside x: [x − 1, x) on +x, [x, x + 1) on −x.
  const px = side > 0 ? x - 1 : x;
  for (let k = 0; k < runs.length; k += 2) {
    const [a, b] = [runs[k], runs[k + 1]];
    if (a <= px && px + 1 <= b) {
      return side > 0
        ? { inward: x - a, outward: b - x }
        : { inward: b - x, outward: x - a };
    }
  }
  return { inward: 0, outward: 0 };
}

/** Rows filled in; `null` without a usable profile. */
function filledProfile(rows: number[] | undefined): number[] | null {
  if (rows === undefined || !rows.some((v) => v > 0)) return null;
  const out = rows.slice();
  const first = out.findIndex((v) => v > 0);
  for (let i = 0; i < first; i++) out[i] = out[first];
  for (let i = first + 1; i < out.length; i++)
    if (!(out[i] > 0)) out[i] = out[i - 1];
  return out;
}

/** A light box filter: a stray pixel on the outline must not move the cut. */
const smoothProfile = (rows: number[]): number[] =>
  boxSmooth(rows, Math.max(1, Math.round(rows.length * 0.01)));

/** Where an ear juts out: the outline steps out by EAR_STEP of the plate's
 *  widest half-width within EAR_ROWS rows, and back in below. */
const EAR_STEP = 0.03;
const EAR_ROWS = 3;

/**
 * An ear on the plate's outline: a step out, a band at least a tenth of the
 * eye→chin span tall, and a step back in, all above the chin. The head's own
 * outline under it is the line between the rows just outside the band.
 */
function findEars(
  raw: number[],
  wMax: number,
  firstRow: number,
  lastRow: number,
  minRows: number,
  maxRows: number,
): { top: number; bottom: number } | undefined {
  const step = Math.max(4, EAR_STEP * wMax);
  for (let t = Math.max(firstRow, EAR_ROWS); t < lastRow; t++) {
    if (raw[t] - raw[t - EAR_ROWS] < step) continue;
    for (let b = t + minRows; b <= Math.min(lastRow, t + maxRows); b++) {
      if (raw[b - EAR_ROWS] - raw[b] >= step) {
        return { top: t - EAR_ROWS, bottom: b };
      }
    }
    return undefined;
  }
  return undefined;
}

function boxSmooth(v: number[], k: number): number[] {
  return v.map((_, i) => {
    let s = 0;
    let n = 0;
    for (let j = i - k; j <= i + k; j++) {
      if (j < 0 || j >= v.length) continue;
      s += v[j];
      n++;
    }
    return s / n;
  });
}

/** How far under the jaw's outline the cut runs, px: the stroke's
 *  antialiased fringe stays on the head. */
const CUT_MARGIN = 2;
/** The cut takes the lowest of each column's neighbours this many columns
 *  either side, and is read linearly between columns. On a jaw rising away
 *  from the chin, that draws the cut's shape — the shade band's end among it
 *  — up to one column more than that further out. */
const CUT_LOW = 3;
/** How much of a depth under the jaw's line holds at offset d from the axis:
 *  all of it under the chin, thinning evenly to none at the neck's outline,
 *  where the outline's own first pixels lie. The cut's fringe margin thins
 *  so, and the depth the neck's hidden rows sample the drawing at. */
export function fadeToOutline(d: number, nk: Neck): number {
  return Math.max(0, 1 - d / nk.waist);
}

/** A measured stroke is the jaw's only if it runs within STROKE_SLACK px of
 *  the median of the STROKE_RUN columns either side of it. */
const STROKE_RUN = 4;
const STROKE_SLACK = 6;
/** Under a measured jaw stroke, the dark band a chin casts on the neck goes
 *  with the chin too (hh): left on the neck, it reads as a second jaw line
 *  once the chin slides off it. It goes only as far as a full turn keeps it
 *  on the neck: given the chin's slide at AngleX 30, the cut draws the
 *  band's end no nearer the waist than that slide and a CUT_MARGIN, so at
 *  ±30 the end lands at least 2 px inside the neck's outline. Carried
 *  further, a turn slides it past the outline, an unlined wedge of neck over
 *  the outline's top. */
const JAW_SHADE = 0.05;

export function buildHeadFrame(
  layers: LayerInput[],
  opts: {
    headHalfWidth?: number;
    headEdges?: HeadEdges;
    /** The chin's slide at AngleX 30, px. Without it the chin's shade band
     *  reaches the neck's outline. */
    chinSlide?: number;
  },
): HeadFrame {
  const byRole = new Map(layers.map((l) => [l.role, l]));
  const faceLayer = byRole.get("face")!;
  const { canvasW, canvasH } = faceLayer;
  const face = boxOfLayer(faceLayer);
  const axisX = cx(face);
  const plateHalf = faceLayer.cropW / 2;

  const centreY = (role: string) => {
    const l = byRole.get(role);
    return l === undefined ? undefined : cy(boxOfLayer(l));
  };
  const pair = (a: string, b: string) => {
    const ya = centreY(a);
    const yb = centreY(b);
    return ya === undefined || yb === undefined ? undefined : (ya + yb) / 2;
  };
  const eyeY = pair("iris_L", "iris_R") ?? pair("eye_L", "eye_R")!;
  const mouthY = centreY("mouth")!;

  // Model y of crop row r's centre, and of its lower boundary.
  const rowY = (r: number) => canvasH / 2 - (faceLayer.bbox.y + r + 0.5);
  const raw = filledProfile(faceLayer.rowHalfWidths);
  const profile = raw === null ? null : smoothProfile(raw);

  let wMax = plateHalf;
  let paintedHalfAt: (y: number) => number = () => plateHalf;
  let neck: Neck | undefined;
  let ears: Ears | undefined;
  let headMax = plateHalf;
  let chinY = face.y0;
  let cutAt: (x: number) => number = () => face.y0 - 1;

  if (profile !== null && raw !== null) {
    wMax = Math.max(...profile);
    headMax = wMax;
    let widestRow = 0;
    for (let r = 0; r < profile.length; r++) {
      if (profile[r] >= wMax - 0.5) widestRow = r;
    }
    const prof = profile;
    paintedHalfAt = (y: number) => {
      const r = canvasH / 2 - y - faceLayer.bbox.y - 0.5;
      const i = clamp(Math.floor(r), 0, prof.length - 1);
      const j = Math.min(i + 1, prof.length - 1);
      const t = clamp(r - i, 0, 1);
      return prof[i] + (prof[j] - prof[i]) * t;
    };

    // Ears, looked for between the plate's top fifth and the chin: the
    // plate's profile with their band replaced by the head's own outline
    // under them (a line between the rows just outside the band).
    const rawRows = raw;
    const earless = (chin: number): number[] => {
      const rowOf = (y: number) =>
        Math.round(canvasH / 2 - y - faceLayer.bbox.y - 0.5);
      const span = Math.max(1, eyeY - chin);
      const found = findEars(
        rawRows,
        wMax,
        Math.round(0.2 * rawRows.length),
        Math.min(rawRows.length - 1, rowOf(chin)),
        Math.round(0.1 * span),
        Math.round(0.8 * span),
      );
      if (found === undefined) return profile;
      const { top, bottom } = found;
      const a = rawRows[top];
      const b = rawRows[bottom];
      const attach = (r: number) =>
        a + ((b - a) * (r - top)) / Math.max(1, bottom - top);
      let outer = 0;
      for (let r = top; r <= bottom; r++) outer = Math.max(outer, rawRows[r]);
      ears = {
        top: rowY(top) + 0.5,
        bottom: rowY(bottom) - 0.5,
        attachAt: (y: number) =>
          attach(clamp(canvasH / 2 - y - faceLayer.bbox.y - 0.5, top, bottom)),
        outer,
      };
      return smoothProfile(
        rawRows.map((v, r) => (r > top && r < bottom ? attach(r) : v)),
      );
    };

    // A neck: below the jaw the plate settles onto a narrow plateau that
    // runs on for a while (the last few rows are the neck's own cut edge).
    const n = profile.length;
    const tail = Math.max(1, Math.floor(n * 0.05));
    let minW = Infinity;
    for (let r = widestRow; r < n - tail; r++)
      minW = Math.min(minW, profile[r]);
    if (Number.isFinite(minW) && minW < 0.7 * wMax) {
      const threshold = minW + 0.15 * (wMax - minW);
      let neckRow = -1;
      for (let r = widestRow + 1; r < n; r++) {
        if (profile[r] <= threshold) {
          neckRow = r;
          break;
        }
      }
      if (neckRow >= 0 && n - neckRow >= 0.12 * n) {
        let span = 0;
        let waist = Infinity;
        for (let r = neckRow; r < n; r++) {
          span = Math.max(span, profile[r]);
          if (r < n - tail) waist = Math.min(waist, profile[r]);
        }
        neck = {
          topY: rowY(neckRow),
          half: profile[neckRow],
          span,
          waist: Math.min(waist, profile[neckRow]),
        };
      }
    }

    if (neck !== undefined) {
      const nk = neck;
      // Where the measurer found the jaw's stroke, per crop column: model y
      // of its lower boundary — only inside the neck, and only between the
      // neck's top and its bottom (a dark mark anywhere else is not a jaw).
      const jaw = faceLayer.jawRows;
      const rawStroke = (i: number): number | undefined => {
        const row = jaw?.[i];
        if (row === undefined || row < 0) return undefined;
        const y = canvasH / 2 - (row + 1);
        return y <= nk.topY + 2 && y > face.y0 + 0.1 * (nk.topY - face.y0)
          ? y
          : undefined;
      };
      // A jaw line runs on from column to column: a stroke far off its
      // neighbours' is some other mark the scan met (a collar, a choker, a
      // column that slipped through the line's antialiasing), not the jaw.
      const strokes = Array.from({ length: faceLayer.cropW }, (_, i) =>
        rawStroke(i),
      );
      const strokeAt = (i: number): number | undefined => {
        const y = strokes[i];
        if (y === undefined) return undefined;
        const near: number[] = [];
        for (let j = i - STROKE_RUN; j <= i + STROKE_RUN; j++) {
          const v = strokes[j];
          if (j !== i && v !== undefined) near.push(v);
        }
        if (near.length < STROKE_RUN) return undefined;
        near.sort((a, b) => a - b);
        const median = near[near.length >> 1];
        return Math.abs(y - median) <= STROKE_SLACK ? y : undefined;
      };
      const colX = (i: number) => faceLayer.bbox.x + i + 0.5 - canvasW / 2;
      // The chin: the stroke's lowest point near the axis, or failing a
      // measured stroke the anime proportion — about half the eye→mouth span
      // under the mouth — kept between the neck's top and its bottom.
      let measuredChin = Infinity;
      for (let i = 0; i < faceLayer.cropW; i++) {
        if (Math.abs(colX(i) - axisX) > 0.35 * nk.half) continue;
        const y = strokeAt(i);
        if (y !== undefined) measuredChin = Math.min(measuredChin, y);
      }
      chinY = Number.isFinite(measuredChin)
        ? measuredChin
        : clamp(
            mouthY - 0.55 * (eyeY - mouthY),
            face.y0 + 0.4 * (nk.topY - face.y0),
            nk.topY,
          );
      // The jaw's own outline at a column offset d from the axis, off the
      // neck: the lowest row above the neck whose span, less any ear, reaches
      // it.
      const neckRow = Math.round(
        canvasH / 2 - nk.topY - faceLayer.bbox.y - 0.5,
      );
      const head = earless(chinY);
      headMax = Math.max(...head);
      const outlineAt = (d: number): number => {
        for (let r = neckRow; r >= 0; r--) {
          if (head[r] >= d) return rowY(r) - 0.5;
        }
        // A column wholly outside the head (past its ears' reach, say)
        // collapses to its top.
        return face.y1;
      };
      const chin = chinY;
      const shade = JAW_SHADE * HH_PER_EYE_TO_CHIN * Math.max(1, eyeY - chin);
      // Where the band thins to nothing: CUT_LOW + 1 columns short of the
      // furthest the cut may draw its end. Without a slide, at the neck's
      // outline.
      const reach =
        opts.chinSlide === undefined
          ? nk.waist
          : clamp(
              nk.waist - opts.chinSlide - CUT_MARGIN - (CUT_LOW + 1),
              0,
              nk.waist,
            );
      // The furthest column the band reaches under a measured stroke.
      let banded = -1;
      const cut = new Float64Array(faceLayer.cropW);
      for (let i = 0; i < faceLayer.cropW; i++) {
        const d = Math.abs(colX(i) - axisX);
        // Across the neck, the jaw's measured stroke; without one, a V from
        // where the jaw meets the neck's sides down to the chin. Beside the
        // neck, the jaw's own outline (below it the layer is empty, save a
        // collar flare the neck keeps).
        const stroke = d <= nk.half ? strokeAt(i) : undefined;
        // The chin's shade goes with the head only across the neck's middle,
        // thinning to nothing at its reach (see JAW_SHADE). The stroke's
        // fringe margin thins on to the outline itself, where not even that
        // goes: the outline's own first pixels would go with it.
        const band = reach > 0 ? Math.max(0, 1 - d / reach) : 0;
        if (stroke !== undefined && band > 0) banded = Math.max(banded, d);
        const y =
          stroke !== undefined
            ? stroke - shade * band - CUT_MARGIN * fadeToOutline(d, nk)
            : (d <= nk.half
                ? chin + (nk.topY - chin) * (d / Math.max(1, nk.half))
                : outlineAt(d)) - CUT_MARGIN;
        // A column wholly outside the head stays collapsed onto its top.
        cut[i] = y >= face.y1 ? face.y1 : y;
      }
      // The lowest of each column's neighbours: a stroke that dips between
      // two sampled columns stays on the head.
      const low = cut.map((_, i) => {
        let m = Infinity;
        for (let j = i - CUT_LOW; j <= i + CUT_LOW; j++) {
          if (j >= 0 && j < cut.length) m = Math.min(m, cut[j]);
        }
        return m;
      });
      // Where the cut draws the band's end: CUT_LOW columns past the last
      // it reaches, then read toward the next.
      if (opts.chinSlide !== undefined && banded >= 0)
        nk.bandEnd = banded + CUT_LOW + 1;
      cutAt = (x: number) => {
        const f = x - (faceLayer.bbox.x - canvasW / 2) - 0.5;
        const i = clamp(Math.floor(f), 0, low.length - 1);
        const j = Math.min(i + 1, low.length - 1);
        const t = clamp(f - i, 0, 1);
        return Math.max(face.y0, low[i] + (low[j] - low[i]) * t);
      };
    } else {
      // No neck: the plate is all head, save its ears, which it ends beside.
      const head = earless(chinY);
      headMax = Math.max(...head);
      if (ears !== undefined) {
        const bottomOf = (d: number): number => {
          for (let r = head.length - 1; r >= 0; r--) {
            if (head[r] >= d) return rowY(r) - 0.5;
          }
          return face.y1;
        };
        cutAt = (x: number) => {
          const y = bottomOf(Math.abs(x - axisX));
          return y >= face.y1 ? face.y1 : Math.max(face.y0, y - CUT_MARGIN);
        };
      }
    }
  }

  const hh = HH_PER_EYE_TO_CHIN * Math.max(1, eyeY - chinY);

  const headHalf = opts.headHalfWidth;
  const hairShell = headHalf !== undefined;
  let shellLeft = axisX - plateHalf;
  let shellRight = axisX + plateHalf;
  if (hairShell) {
    if (
      opts.headEdges &&
      opts.headEdges.left.length > 0 &&
      opts.headEdges.right.length > 0
    ) {
      shellLeft = Math.min(...opts.headEdges.left.map((e) => e.x));
      // A right edge names its outermost pixel column; its outer boundary is
      // one pixel further.
      shellRight = Math.max(...opts.headEdges.right.map((e) => e.x)) + 1;
    } else {
      shellLeft = axisX - headHalf;
      shellRight = axisX + headHalf;
    }
  }

  const hairRuns = (
    role: "hair_front" | "hair_back",
    y: number,
  ): number[] | undefined => {
    const l = byRole.get(role);
    if (l?.rowRuns === undefined) return undefined;
    const runs = l.rowRuns[Math.floor(canvasH / 2 - y) - l.bbox.y];
    return runs === undefined ? [] : runs.map((c) => c - canvasW / 2);
  };

  return {
    canvasW,
    canvasH,
    face,
    axisX,
    eyeY,
    mouthY,
    chinY,
    hh,
    paintedHalfAt,
    wMax,
    headMax,
    hasProfile: profile !== null,
    neck,
    ears,
    cutAt,
    cheekY: eyeY - 0.5 * (eyeY - chinY),
    jawY: eyeY - 0.8 * (eyeY - chinY),
    shellLeft,
    shellRight,
    hairShell,
    holdBase: headHalf ?? plateHalf,
    hairRuns,
  };
}
