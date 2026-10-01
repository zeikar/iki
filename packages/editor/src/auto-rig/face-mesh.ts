/**
 * The face plate's mesh: the head, and — when the face layer paints them — the
 * neck and the ears as further islands of the same drawing, drawn first so the
 * head slides over them. The head island ends just under the jaw's outline and
 * along the head's own outline under each ear; the neck island runs from the
 * collar up under the jaw, its hidden top stretching the neck's first rows
 * under the jaw upward, so a chin sliding off it uncovers neck rather than the
 * chin painted there; each ear island reaches in under the head a little —
 * on the near side that tuck rides the head, on the far side it slides deeper
 * under it as the ear lags — so an ear never opens a gap beside it.
 */

import type { IkiMesh } from "@ikijs/format";
import { fadeToOutline, type HeadFrame } from "./head";
import {
  bh,
  bw,
  cellsFor,
  clamp,
  cx,
  cy,
  roundTo,
  type Box,
  type Cells,
} from "./layout";
import { AMPLITUDE } from "./profile";

export type Region = "head" | "neck" | "ear";

export interface FaceMesh {
  mesh: IkiMesh;
  /** Per vertex: the island it belongs to. */
  region: Region[];
  /** The head island's triangles start at this index into `mesh.indices`. */
  headStart: number;
}

/** How far below the cut the neck's hidden top samples the drawing, hh: in
 *  the neck's shade, clear of the jaw's own line and its darkest band, so the
 *  neck a chin uncovers is one even tone. */
const SAMPLE_BELOW = 0.04;
/** How far an ear island reaches in under the head's outline, hh: enough to
 *  stay under the head island's edge, which follows that line only through
 *  the island's columns and strays a little either side of it between them.
 *  On the near side the tuck rides the head; on the far side it slides
 *  deeper under it as the ear lags. */
const EAR_TUCK = 0.08;

export function buildFaceMesh(
  frame: HeadFrame,
  b: Box,
  head: Cells,
  neckCells: Cells,
): FaceMesh {
  const vertices: number[] = [];
  const uvs: number[] = [];
  const region: Region[] = [];
  const pos: [number, number][] = [];
  const add = (x: number, y: number, uy: number, r: Region): number => {
    vertices.push(
      roundTo((x - cx(b)) / bw(b), 1e-5),
      roundTo((y - cy(b)) / bh(b), 1e-5),
    );
    uvs.push(
      roundTo((x - b.x0) / bw(b), 1e-5),
      roundTo((b.y1 - uy) / bh(b), 1e-5),
    );
    region.push(r);
    pos.push([x, y]);
    return region.length - 1;
  };
  // A cell's two triangles, less either one with no area (a column that
  // lies wholly outside the head collapses to its top).
  const quad = (
    out: number[],
    tl: number,
    tr: number,
    bl: number,
    br: number,
  ) => {
    for (const [p, q, t] of [
      [bl, br, tl],
      [tl, br, tr],
    ]) {
      // Two corners on one spot (a collapsed column's rows) make a sliver
      // that only rounding gives an area.
      const apart = (i: number, j: number) =>
        Math.hypot(pos[i][0] - pos[j][0], pos[i][1] - pos[j][1]) > 0.5;
      const area =
        (pos[q][0] - pos[p][0]) * (pos[t][1] - pos[p][1]) -
        (pos[t][0] - pos[p][0]) * (pos[q][1] - pos[p][1]);
      if (apart(p, q) && apart(q, t) && apart(p, t) && Math.abs(area) > 0.5)
        out.push(p, q, t);
    }
  };
  const pad = 3 + 0.1 * frame.wMax;
  // Whether the plate's paint reaches into [x0, x1] on any row between yTop
  // and yBot (its row spans are half-widths about the axis, so an off-centre
  // row gets the pad).
  const painted = (
    x0: number,
    x1: number,
    yTop: number,
    yBot: number,
  ): boolean => {
    for (let i = 0; i <= 8; i++) {
      const y = yTop + ((yBot - yTop) * i) / 8;
      const w = frame.paintedHalfAt(y) + pad;
      if (x1 >= frame.axisX - w && x0 <= frame.axisX + w) return true;
    }
    return false;
  };

  // A lattice whose rows run between a per-column top and bottom, cells kept
  // by `keep`; returns its triangles.
  const island = (
    xs: number[],
    rowsOf: (x: number) => { y: number; uy: number }[],
    r0: Region,
    keep: (c: number, r: number, col: { y: number }[][]) => boolean,
  ): number[] => {
    const cols = xs.map((x) => rowsOf(x));
    const ids = cols.map((col, c) => col.map((p) => add(xs[c], p.y, p.uy, r0)));
    const out: number[] = [];
    const rows = cols[0].length - 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c + 1 < xs.length; c++) {
        if (!keep(c, r, cols)) continue;
        quad(out, ids[c][r], ids[c + 1][r], ids[c][r + 1], ids[c + 1][r + 1]);
      }
    }
    return out;
  };

  // Columns at even steps, plus the chin's and the jaw corners' own, so the
  // cut's V runs through vertices rather than chording off its tip, and the
  // chin's shade band's ends, so no cell chords the band on past them.
  const columns = (x0: number, x1: number, n: number): number[] => {
    const xs = Array.from(
      { length: n + 1 },
      (_, c) => x0 + ((x1 - x0) * c) / n,
    );
    const neck = frame.neck;
    const step = (x1 - x0) / n;
    // The head's own widest reach (its ears left out): past it a column is
    // wholly outside the head, and the head island must still reach it.
    const at = [
      frame.axisX - frame.headMax + 0.5,
      frame.axisX + frame.headMax - 0.5,
    ];
    if (neck !== undefined) {
      at.push(
        frame.axisX,
        frame.axisX - neck.half,
        frame.axisX + neck.half,
        frame.axisX - neck.waist,
        frame.axisX + neck.waist,
      );
      if (neck.bandEnd !== undefined)
        at.push(frame.axisX - neck.bandEnd, frame.axisX + neck.bandEnd);
    }
    // Each takes the even column near it (not an end), or one of its own —
    // never a column another has taken, so none of them is lost; one near an
    // end is left to it, and one within half a pixel of a taken column is that
    // column.
    const placed = new Set<number>();
    for (const k of at) {
      if (k <= x0 || k >= x1) continue;
      if ([...placed].some((i) => Math.abs(xs[i] - k) < 0.5)) continue;
      const near = xs.findIndex(
        (x, i) => !placed.has(i) && Math.abs(x - k) < 0.3 * step,
      );
      if (near > 0 && near < n) {
        xs[near] = k;
        placed.add(near);
      } else if (near < 0) placed.add(xs.push(k) - 1);
    }
    return xs.sort((a, b) => a - b);
  };

  const indices: number[] = [];
  const neck = frame.neck;
  if (neck !== undefined) {
    const span = neck.span + pad;
    const nc = cellsFor(2 * span, neckCells.px, neckCells.min, neckCells.max);
    // Inside the crop: a collar flaring nearly as wide as the plate must not
    // put a vertex's texture off it.
    const xs = columns(
      Math.max(b.x0, frame.axisX - span),
      Math.min(b.x1, frame.axisX + span),
      nc,
    );
    // The hidden rows show the drawing SAMPLE_BELOW under the cut, thinning
    // to the row just under it at the neck's outline (which must run on
    // unbroken above the cut). Under the chin that is the neck below the
    // shade band the head carries; past the band's end, where the cut runs
    // just under the stroke, it is whatever shade the neck keeps there.
    const sampleBelow = (x: number) =>
      Math.max(
        1,
        SAMPLE_BELOW *
          frame.hh *
          fadeToOutline(Math.abs(x - frame.axisX), neck),
      );
    // The jaw's corners: the highest the cut runs across the neck. Beside
    // the neck a column's cut is the head's own side outline instead, up the
    // cheek (or, past the head's widest reach, the plate's top): there the
    // island only carries what the plate paints under the jaw's corners — a
    // collar's flare — or it would hold a still copy of the cheek beside the
    // turning head.
    let highest = -Infinity;
    for (const x of xs) {
      if (Math.abs(x - frame.axisX) <= neck.half)
        highest = Math.max(highest, frame.cutAt(x));
    }
    const cutOf = (x: number) => Math.min(frame.cutAt(x), highest);
    // One level top, above the jaw's corners: a top following the jaw's V
    // would show its own diagonal edge once the chin slides and lifts off it.
    const top = Math.min(b.y1, highest + AMPLITUDE.hiddenNeck * frame.hh);
    const realRows = cellsFor(
      highest - b.y0,
      neckCells.px,
      neckCells.min,
      neckCells.max,
    );
    // Two rows reaching up under the jaw, a third a pixel above the cut, all
    // showing the neck's shade; then the neck as drawn, from the cut down.
    const hiddenRows = 3;
    indices.push(
      ...island(
        xs,
        (x) => {
          const cut = cutOf(x);
          const sample = Math.max(b.y0, cut - sampleBelow(x));
          const pts: { y: number; uy: number }[] = [
            { y: top, uy: sample },
            { y: (top + cut) / 2, uy: sample },
            { y: cut + 1, uy: sample },
            { y: cut, uy: cut },
          ];
          // Level rows, shared by every column (a column's own rows above
          // its cut collapse onto it): the neck's cells stay square rather
          // than slanting with the jaw's V.
          for (let r = 1; r <= realRows; r++) {
            const y = Math.min(
              cut,
              highest - ((highest - b.y0) * r) / realRows,
            );
            pts.push({ y, uy: y });
          }
          return pts;
        },
        "neck",
        (c, r, cols) => {
          const top = Math.max(cols[c][r].y, cols[c + 1][r].y);
          const bot = Math.min(cols[c][r + 1].y, cols[c + 1][r + 1].y);
          if (r < hiddenRows) {
            // The hidden rows show the drawing just under the jaw.
            const mid = (xs[c] + xs[c + 1]) / 2;
            const y = Math.max(b.y0, cutOf(mid) - sampleBelow(mid));
            return painted(xs[c], xs[c + 1], y, y);
          }
          return painted(xs[c], xs[c + 1], top, bot);
        },
      ),
    );
  }
  const ears = frame.ears;
  if (ears !== undefined) {
    // Rows over the band, each running from under the head's outline (by
    // EAR_TUCK) out past the ear.
    const tuck = EAR_TUCK * frame.hh;
    const yTop = Math.min(b.y1, ears.top + 2);
    const yBot = Math.max(b.y0, ears.bottom - 2);
    const nr = cellsFor(yTop - yBot, 16, 3, 10);
    const outer = ears.outer + pad;
    let inner = Infinity;
    for (let r = 0; r <= nr; r++)
      inner = Math.min(inner, ears.attachAt(yTop - ((yTop - yBot) * r) / nr));
    const nc = cellsFor(outer - (inner - tuck), 12, 2, 6);
    for (const side of [-1, 1] as const) {
      const ids: number[][] = [];
      const xsOf: number[][] = [];
      for (let r = 0; r <= nr; r++) {
        const y = yTop - ((yTop - yBot) * r) / nr;
        const d0 = Math.max(0, ears.attachAt(y) - tuck);
        const row: number[] = [];
        const xs: number[] = [];
        for (let c = 0; c <= nc; c++) {
          // Left to right whichever side, so the cells wind as the head's.
          const k = side < 0 ? nc - c : c;
          const x = clamp(
            frame.axisX + side * (d0 + ((outer - d0) * k) / nc),
            b.x0,
            b.x1,
          );
          xs.push(x);
          row.push(add(x, y, y, "ear"));
        }
        ids.push(row);
        xsOf.push(xs);
      }
      for (let r = 0; r < nr; r++) {
        for (let c = 0; c < nc; c++) {
          const x0 = Math.min(xsOf[r][c], xsOf[r + 1][c]);
          const x1 = Math.max(xsOf[r][c + 1], xsOf[r + 1][c + 1]);
          const yt = yTop - ((yTop - yBot) * r) / nr;
          const yb = yTop - ((yTop - yBot) * (r + 1)) / nr;
          if (!painted(x0, x1, yt, yb)) continue;
          quad(
            indices,
            ids[r][c],
            ids[r][c + 1],
            ids[r + 1][c],
            ids[r + 1][c + 1],
          );
        }
      }
    }
  }

  const headStart = indices.length;
  const cols = cellsFor(bw(b), head.px, head.min, head.max);
  const rows = cellsFor(bh(b), head.px, head.min, head.max);
  const xs = columns(b.x0, b.x1, cols);
  indices.push(
    ...island(
      xs,
      (x) => {
        const bottom = Math.max(b.y0, frame.cutAt(x));
        return Array.from({ length: rows + 1 }, (_, r) => {
          const y = b.y1 - ((b.y1 - bottom) * r) / rows;
          return { y, uy: y };
        });
      },
      "head",
      (c, r, cols) => {
        // A column wholly outside the head (past the ears' reach, beside the
        // neck) has collapsed to its top: fanning cells out of it would
        // sweep over the ear.
        const height = (k: number) =>
          cols[k][0].y - cols[k][cols[k].length - 1].y;
        if (height(c) < 1 || height(c + 1) < 1) return false;
        return painted(
          xs[c],
          xs[c + 1],
          Math.max(cols[c][r].y, cols[c + 1][r].y),
          Math.min(cols[c][r + 1].y, cols[c + 1][r + 1].y),
        );
      },
    ),
  );
  return { mesh: { vertices, uvs, indices }, region, headStart };
}
