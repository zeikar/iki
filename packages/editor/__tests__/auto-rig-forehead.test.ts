// The forehead under the bangs on the head turn: the plate's far side held
// back where the front hair over its outline turns less than the plate does.

import { describe, expect, it } from "vitest";
import type { IkiModel } from "@ikijs/format";
import { character, type CharacterOptions } from "./helpers/character";
import {
  landVertices,
  landedXAt,
  rig,
  signedAreas,
  ALL_RUNS,
  X30,
} from "./helpers/head-rig";

/** The plate's top row and the eyes' top row, canvas rows. */
const PLATE_TOP = 200;
const EYES_TOP = 400;
/** The temple band's end: from here down the bangs are the wide strands. */
const TEMPLE_END = 330;

/** Model y of canvas row k's centre. */
const rowY = (k: number) => 500 - k - 0.5;

/** A layer's outer edges on canvas row k, model x: [−x side, +x side]. */
function edges(opts: CharacterOptions, role: string, k: number) {
  const l = character(opts).layers.find((l) => l.role === role)!;
  const runs = l.rowRuns![k - l.bbox.y];
  return [runs[0] - 500, runs[runs.length - 1] - 500] as const;
}

/** How far a layer's outer edge on `side` of row k moves along a turn to
 *  `ax`, px (read half a pixel inside it). */
function edgeShift(
  model: IkiModel,
  opts: CharacterOptions,
  role: string,
  k: number,
  side: -1 | 1,
  ax: number,
): number {
  const x = edges(opts, role, k)[side < 0 ? 0 : 1] - side * 0.5;
  return landedXAt(model, role, x, rowY(k), X30(ax)) - x;
}

/** How far the plate's outline on `side` of row k lands outside the bangs'
 *  edge there at `ax`, px: positive is forehead showing past the bangs. */
function leak(
  model: IkiModel,
  opts: CharacterOptions,
  k: number,
  side: -1 | 1,
  ax: number,
): number {
  const i = side < 0 ? 0 : 1;
  const face = edges(opts, "face", k)[i];
  const hair = edges(opts, "hair_front", k)[i];
  return (
    side *
    (face +
      edgeShift(model, opts, "face", k, side, ax) -
      (hair + edgeShift(model, opts, "hair_front", k, side, ax)))
  );
}

/** The plate's slide at the axis on row k, along a turn to `ax`, px. */
const slide = (model: IkiModel, k: number, ax: number) =>
  Math.sign(ax) * (landedXAt(model, "face", 0.5, rowY(k), X30(ax)) - 0.5);

const rows = (from: number, to: number, step = 6) =>
  Array.from(
    { length: Math.ceil((to - from) / step) },
    (_, i) => from + i * step,
  );

describe("the forehead under the bangs on the turn", () => {
  const thin: CharacterOptions = { thinTemple: 4 };
  const { model } = rig(thin);

  it("keeps a thinly covered forehead under the bangs' edge on the far side", () => {
    for (const side of [-1, 1] as const) {
      for (const k of rows(PLATE_TOP + 2, TEMPLE_END)) {
        // The bangs' edge, bound to a back hair barely wider, turns less
        // than the plate: without the hold the forehead would pass it.
        const plate = slide(model, k, 30 * side);
        const hair =
          side * edgeShift(model, thin, "hair_front", k, side, 30 * side);
        expect(plate - hair).toBeGreaterThan(4);
        for (const ax of [15 * side, 30 * side]) {
          expect(leak(model, thin, k, side, ax)).toBeLessThanOrEqual(1e-6);
        }
        // Held no further than that: the outline stays within a pixel and a
        // half of the bangs' edge.
        expect(leak(model, thin, k, side, 30 * side)).toBeGreaterThan(-1.5);
      }
    }
  });

  it("spreads a row's hold to the rows around it, less the further off, also where the bangs cover the forehead widely", () => {
    // Under the temple's end the bangs are the wide strands, 70 px and more
    // outside the plate's outline: those rows ask for nothing themselves.
    for (const side of [-1, 1] as const) {
      const ax = 30 * side;
      const held = (k: number) =>
        slide(model, k, ax) -
        side * edgeShift(model, thin, "face", k, side, ax);
      const [last, next, ...below] = [
        TEMPLE_END - 6,
        TEMPLE_END + 6,
        352,
        372,
        392,
      ].map(held);
      // Within a cell of the last row that asks: nearly whole.
      expect(next).toBeGreaterThan(0.9 * last);
      // Then less row by row, to a few px near the eyes' top.
      [next, ...below].reduce((above, h) => {
        expect(h).toBeLessThan(above);
        expect(h).toBeGreaterThan(0);
        return h;
      });
      expect(below[below.length - 1]).toBeLessThan(0.2 * last);
    }
  });

  it("turns the plate whole at the axis and on the near side", () => {
    for (const side of [-1, 1] as const) {
      for (const k of rows(PLATE_TOP + 2, EYES_TOP)) {
        const ax = -30 * side;
        // `side` is the near side turning toward −side.
        const near = -side * edgeShift(model, thin, "face", k, side, ax);
        expect(near).toBeCloseTo(slide(model, k, ax), 3);
        expect(slide(model, k, ax)).toBeCloseTo(
          slide(model, EYES_TOP + 30, ax),
          3,
        );
      }
    }
  });

  it("turns the plate whole from the eyes' top down", () => {
    const whole = rig(thin, {}, { drop: ALL_RUNS }).model;
    for (const ax of [-30, 30]) {
      const v = landVertices(model, "face", X30(ax));
      const w = landVertices(whole, "face", X30(ax));
      const rest = landVertices(model, "face");
      let below = 0;
      for (let i = 0; i < rest.length; i += 2) {
        if (rest[i + 1] > rowY(EYES_TOP) + 0.5) continue;
        below++;
        expect(v[i]).toBeCloseTo(w[i], 3);
        expect(v[i + 1]).toBeCloseTo(w[i + 1], 3);
      }
      expect(below).toBeGreaterThan(20);
    }
  });

  it("folds no cell of the plate", () => {
    const part = model.parts.find((p) => p.id === "face")!;
    const rest = signedAreas(landVertices(model, "face"), part.mesh!.indices);
    for (const ax of [-30, 30]) {
      const turned = signedAreas(
        landVertices(model, "face", X30(ax)),
        part.mesh!.indices,
      );
      turned.forEach((a, t) => {
        // The eased span keeps half its width on every row; a cell leaning
        // across rows loses a little more, and none comes near folding.
        expect(a / rest[t]).toBeGreaterThan(0.35);
      });
    }
  });

  it("holds nothing where the bangs cover the forehead by more than the plate's slide", () => {
    const wide: CharacterOptions = { wideBack: true };
    const { model: m } = rig(wide);
    for (const side of [-1, 1] as const) {
      for (const k of rows(PLATE_TOP + 2, EYES_TOP)) {
        const ax = 30 * side;
        const far = side * edgeShift(m, wide, "face", k, side, ax);
        expect(far).toBeCloseTo(slide(m, k, ax), 3);
      }
    }
  });

  it("holds nothing where the forehead's sides show past the bangs at rest", () => {
    // The bangs end 20 px inside the plate's outline: the outline is the
    // head's own there, and turns with the plate.
    const bare: CharacterOptions = { thinTemple: -20 };
    const { model: m } = rig(bare);
    for (const side of [-1, 1] as const) {
      for (const k of rows(PLATE_TOP + 2, EYES_TOP)) {
        const ax = 30 * side;
        const far = side * edgeShift(m, bare, "face", k, side, ax);
        expect(far).toBeCloseTo(slide(m, k, ax), 3);
      }
    }
  });

  it("holds nothing without the layers' runs", () => {
    const { model: m } = rig(thin, {}, { drop: ALL_RUNS });
    for (const side of [-1, 1] as const) {
      for (const k of rows(PLATE_TOP + 2, EYES_TOP)) {
        const ax = 30 * side;
        const far = side * edgeShift(m, thin, "face", k, side, ax);
        expect(far).toBeCloseTo(slide(m, k, ax), 3);
      }
    }
  });
});
