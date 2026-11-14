import { describe, expect, it } from "vitest";
import { type IkiModel } from "@ikijs/format";
import { generateIkiFromLayerSet, type LayerInput } from "@ikijs/editor";
import { buildHeadFrame, type HeadFrame } from "../src/auto-rig/head";
import { AMPLITUDE, TURN } from "../src/auto-rig/profile";
import { type GenerateOptions } from "../src/auto-rig/types";
import { CANVAS, character } from "./helpers/character";
import {
  landVertices,
  landedXAt,
  triangles,
  plateDraws,
  exposedStill,
  X30,
  withEars,
} from "./helpers/head-rig";

describe("the jaw cut", () => {
  /** The fixture's face with a measured jaw stroke: a V from where the jaw
   *  meets the neck (canvas row 648, 78 px either side of the axis) down to
   *  the chin at row 692. */
  function jawed(edit: (rows: number[]) => void = () => {}) {
    const { layers, options } = character();
    const face = layers.find((l) => l.role === "face")!;
    const rows = Array.from({ length: face.bbox.w }, (_, i) => {
      const d = Math.abs(face.bbox.x + i + 0.5 - 500.5);
      return d <= 78 ? Math.round(692 - (d / 78) * 44) : -1;
    });
    edit(rows);
    return {
      layers: layers.map((l) => (l === face ? { ...l, jawRows: rows } : l)),
      options,
    };
  }
  function withJaw(edit: (rows: number[]) => void = () => {}) {
    const { layers, options } = jawed(edit);
    return generateIkiFromLayerSet(layers, CANVAS, options);
  }
  /** The stroke's lower boundary, model y, at offset d from the axis. */
  const jawStroke = (d: number) => 500 - (Math.round(692 - (d / 78) * 44) + 1);
  const frameOf = (layers: LayerInput[], options: GenerateOptions) =>
    buildHeadFrame(layers, {
      headHalfWidth: 262,
      headEdges: options.headEdges,
    });

  /** How many samples of the plate a turn of `ax` lands past the neck's
   *  outline from inside it, of those lying more than `depth` px under the
   *  jaw's stroke at rest. */
  function pastOutline(
    m: IkiModel,
    frame: HeadFrame,
    stroke: (d: number) => number,
    depth: number,
    ax: number,
  ): number {
    const { axisX } = frame;
    const waist = frame.neck!.waist;
    const rest = landVertices(m, "face");
    const v = landVertices(m, "face", X30(ax));
    const tris = triangles(m.parts.find((p) => p.id === "face")!.mesh!.indices);
    const S = 6;
    let past = 0;
    for (const t of tris) {
      for (let i = 0; i <= S; i++) {
        for (let j = 0; i + j <= S; j++) {
          const w = [i / S, j / S, (S - i - j) / S];
          const at = (p: Float32Array, k: number) =>
            w.reduce((s, wk, n) => s + wk * p[t[n] * 2 + k], 0);
          const d = Math.abs(at(rest, 0) - axisX);
          if (d >= waist || at(rest, 1) >= stroke(d) - depth) continue;
          if (Math.abs(at(v, 0) - axisX) > waist) past++;
        }
      }
    }
    return past;
  }
  const pivotY = (m: IkiModel) =>
    (
      m.deformers!.find((d) => d.id === "headDeformer") as {
        pivot: { y: number };
      }
    ).pivot.y;

  it("pivots the roll on the measured chin, and shrugs off a stray mark", () => {
    const m = withJaw();
    expect(pivotY(m)).toBeCloseTo(500 - 693, 0);
    // One column meeting a collar line far below the jaw is not the chin.
    const stray = withJaw((rows) => {
      rows[200] = 745;
    });
    // (Without that column the chin reads off its neighbour, a pixel up.)
    expect(Math.abs(pivotY(stray) - pivotY(m))).toBeLessThanOrEqual(1);
  });

  it("carries the chin's shade with the head under the chin only, thinning it to nothing short of the neck's outline by the chin's slide", () => {
    const { layers, options } = jawed();
    const frame = frameOf(layers, options);
    const stroke = jawStroke;
    // Under the chin the cut runs a band's depth below the jaw's stroke...
    expect(stroke(0) - frame.cutAt(0.5)).toBeGreaterThan(10);
    // ...and at the neck's outline (its waist, 78) right under it, so the
    // head carries none of the neck's own outline off with it.
    const waist = frame.neck!.waist;
    expect(
      Math.abs(stroke(waist - 1) - frame.cutAt(0.5 - (waist - 1))),
    ).toBeLessThan(2.5);
    // Given a chin's slide at a full turn (51 px, where the fixture's fringe
    // margin has thinned), the band still runs deep under the chin, but the
    // cut draws its end that slide and 2 px short of the outline: past there,
    // only the fringe margin (thinned there to under 1.4 px) and the cut's low
    // filter over three columns of the V (about 1.7 px) lie under the stroke.
    // The profile's own slide is checked end to end below.
    const slide = 51;
    const turned = buildHeadFrame(layers, {
      headHalfWidth: 262,
      headEdges: options.headEdges,
      chinSlide: slide,
    });
    const { axisX } = turned;
    expect(stroke(0) - turned.cutAt(axisX)).toBeGreaterThan(10);
    for (let d = waist - slide - 2; d < waist; d++) {
      for (const x of [axisX - d, axisX + d]) {
        expect(stroke(d) - turned.cutAt(x), `x ${x}`).toBeLessThan(3.5);
      }
    }
  });

  it("keeps the chin's shade inside the neck through the turn", () => {
    const { layers, options } = jawed();
    const m = generateIkiFromLayerSet(layers, CANVAS, options);
    const frame = frameOf(layers, options);
    // The drawing more than 4 px under the stroke (its fringe margin and the
    // cut's low filter on the V, about 3 px, lie within that) lands inside
    // the neck.
    for (const ax of [-30, -15, 15, 30]) {
      expect(pastOutline(m, frame, jawStroke, 4, ax), `AngleX ${ax}`).toBe(0);
    }
  });

  it("keeps the chin's shade inside a slim neck, which leaves the band little room or none", () => {
    for (const waist of [54, 56, 58, 60, 64]) {
      // The fixture's neck narrowed to `waist`, its jaw stroke a V from the
      // chin (canvas row 692) up to where the jaw meets the neck's sides.
      const { layers, options } = character();
      const face = layers.find((l) => l.role === "face")!;
      const h = face.bbox.h;
      const prof = face.rowHalfWidths!.map((w, r) => {
        const t = r / h;
        if (t < 0.5 || r >= h - 4) return w;
        const v = t < 0.8 ? 198 - (198 - waist) * ((t - 0.5) / 0.3) : waist;
        return Math.round(v * 2) / 2;
      });
      const half = waist + 0.15 * (198 - waist);
      const top = face.bbox.y + prof.findIndex((w, r) => r > 100 && w <= half);
      const row = (d: number) => Math.round(692 - (d / half) * (692 - top));
      const rows = Array.from({ length: face.bbox.w }, (_, i) => {
        const d = Math.abs(face.bbox.x + i + 0.5 - 500.5);
        return d <= half ? row(d) : -1;
      });
      const slim = layers.map((l) =>
        l === face ? { ...l, rowHalfWidths: prof, jawRows: rows } : l,
      );
      const m = generateIkiFromLayerSet(slim, CANVAS, options);
      const frame = frameOf(slim, options);
      expect(frame.neck!.waist).toBe(waist);
      // Past the stroke's fringe (2 px) and the cut's low filter over three
      // columns of this steeper V (and a quarter pixel for the stroke's
      // rounded rows), nothing lands past the outline.
      const depth = 2 + (3 * (692 - top)) / half + 0.25;
      const stroke = (d: number) => 500 - (row(d) + 1);
      for (const ax of [-30, -15, 15, 30]) {
        expect(
          pastOutline(m, frame, stroke, depth, ax),
          `waist ${waist}, AngleX ${ax}`,
        ).toBe(0);
      }
    }
  });

  it("keeps the neck's texture on the drawing: a collar as wide as the plate, a neck stub", () => {
    const { layers, options } = character();
    const face = layers.find((l) => l.role === "face")!;
    // The neck flares to nearly the plate's width at its cut edge.
    const flared = layers.map((l) =>
      l === face
        ? {
            ...l,
            rowHalfWidths: face.rowHalfWidths!.map((w, r) =>
              r >= face.bbox.h - 30 ? 190 : w,
            ),
          }
        : l,
    );
    const m = generateIkiFromLayerSet(flared, CANVAS, options);
    // Beside the jaw the collar's columns carry the collar alone: nothing
    // of the still neck shows above what a sliding chin uncovers (its hidden
    // top, AMPLITUDE.hiddenNeck over the jaw's corners) — no still copy of
    // the cheek beside the turned head.
    const frame = buildHeadFrame(flared, {
      headHalfWidth: 262,
      headEdges: options.headEdges,
    });
    const above = frame.neck!.topY + AMPLITUDE.hiddenNeck * frame.hh;
    for (const ax of [-30, 30]) {
      expect(exposedStill(m, X30(ax), above), `AngleX ${ax}`).toBe(0);
    }
    // The collar is still drawn out to its flare (canvas rows 730…759).
    const draws = plateDraws(m);
    for (const y of [-258, -245, -232]) {
      for (let x = -188.5; x <= 190; x += 3) {
        expect(draws(x, y), `(${x}, ${y})`).toBe(true);
      }
    }
    // A jaw stroke measured right at the bottom of a short neck.
    expect(() =>
      withJaw((rows) => {
        for (let i = 0; i < rows.length; i++) if (rows[i] >= 0) rows[i] = 757;
      }),
    ).not.toThrow();
  });
});

describe("the ears", () => {
  /** The silhouette ratio a head without hair fits at a shellScale of
   *  `shell`: its plate's width at full turn, scaled. */
  const shellRatio = (shell: number) => shell * TURN.widthUpper;

  /** The plate without its head island (its largest): what the other
   *  islands draw, the ears' roots under the head included — the head's
   *  edge strays past the line under an ear between its columns. */
  function withoutHead(model: IkiModel): IkiModel {
    const part = model.parts.find((p) => p.id === "face")!;
    const tris = triangles(part.mesh!.indices);
    const root = Array.from(
      { length: part.mesh!.vertices.length / 2 },
      (_, i) => i,
    );
    const find = (i: number): number =>
      root[i] === i ? i : (root[i] = find(root[i]));
    for (const [a, b, c] of tris) {
      root[find(b)] = find(a);
      root[find(c)] = find(a);
    }
    const size = new Map<number, number>();
    for (const [a] of tris) size.set(find(a), (size.get(find(a)) ?? 0) + 1);
    const head = [...size].reduce((p, q) => (q[1] > p[1] ? q : p))[0];
    const indices = tris.filter(([a]) => find(a) !== head).flat();
    return {
      ...model,
      parts: model.parts.map((p) =>
        p === part ? { ...p, mesh: { ...p.mesh!, indices } } : p,
      ),
    };
  }

  it("lags the ears behind the face — the far one most — with no seam at rest", () => {
    const { m, frame } = withEars();
    // On crop row 215 (model y 500 − 200 − 215): the far ear at its outer
    // rim, the near one at its widest reach, where each lag is whole.
    const ear = (x: number, ax: number) =>
      landedXAt(m, "face", x, 85, X30(ax)) - x;
    const face = (ax: number) => landedXAt(m, "face", 0.5, 85, X30(ax)) - 0.5;
    for (const ax of [-30, 30]) {
      const s = Math.sign(ax);
      const far = frame.axisX + s * (frame.ears!.outer - 0.5);
      const near = frame.axisX - s * frame.ears!.outer;
      expect(ear(far, ax) / face(ax)).toBeCloseTo(TURN.earFar, 2);
      expect(ear(near, ax) / face(ax)).toBeCloseTo(TURN.earNear, 1);
    }
    // At rest every island lies where it is drawn.
    const v = landVertices(m, "face");
    const part = m.parts.find((p) => p.id === "face")!;
    for (let i = 0; i < v.length / 2; i++) {
      expect(v[i * 2]).toBeCloseTo(
        part.transform.x + part.mesh!.vertices[i * 2] * part.width,
        3,
      );
    }
  });

  it("moves the near ear's root, tucked under the head, as the head moves it", () => {
    const { m, frame } = withEars();
    const ears = frame.ears!;
    const rest = landVertices(m, "face");
    for (const ax of [-30, 30]) {
      const pose = X30(ax);
      const v = landVertices(m, "face", pose);
      let tucked = 0;
      for (let i = 0; i < rest.length / 2; i++) {
        const [x, y] = [rest[i * 2], rest[i * 2 + 1]];
        const u = x - frame.axisX;
        // On the ear band, inside the head's own outline, on the near side.
        if (y < ears.bottom || y > ears.top) continue;
        if (Math.abs(u) >= ears.attachAt(y) - 1) continue;
        if (Math.sign(ax) * u > 0) continue;
        // The head island is drawn last, so this reads how it moves there.
        const head = landedXAt(m, "face", x, y, pose);
        expect(
          Math.abs(v[i * 2] - head),
          `(${x}, ${y}) at AngleX ${ax}`,
        ).toBeLessThan(0.5);
        // The ear island's own inner column, EAR_TUCK (0.08 hh) inside the
        // line — not only the head's vertices over it.
        const tuck = ears.attachAt(y) - 0.08 * frame.hh;
        if (Math.abs(Math.abs(u) - tuck) < 0.05) tucked++;
      }
      expect(tucked).toBeGreaterThan(0);
    }
  });

  it("narrows the far ear to the profile's width at a full turn", () => {
    const { m, frame } = withEars();
    const ears = frame.ears!;
    // On row 85, from just outside the head's own outline to just inside the
    // ear's outer rim — read off the ear's island, which the head's edge
    // covers a few px past that line here.
    const ear = withoutHead(m);
    const d0 = ears.attachAt(85) + 2;
    const d1 = ears.outer - 2;
    const half = (1 + TURN.earFarScale) / 2;
    for (const [ax, width] of [
      [-30, TURN.earFarScale],
      [-15, half],
      [15, half],
      [30, TURN.earFarScale],
    ]) {
      const s = Math.sign(ax);
      const at = (d: number) =>
        landedXAt(ear, "face", frame.axisX + s * d, 85, X30(ax));
      const span = (s * (at(d1) - at(d0))) / (d1 - d0);
      expect(Math.abs(span - width), `AngleX ${ax}: ${span}`).toBeLessThan(
        0.01,
      );
    }
  });

  it("keeps the far ear's tucked strip under the head", () => {
    // Without hair the plate narrows. At silhouetteRatio 0.9 the head still
    // moves well past the ear's held outer edge on the line under it; at a
    // shellScale of 0.8 the solve stops the narrowing where the head barely
    // moves there, so the root is held, short of the ear's full narrowing.
    for (const { m, frame } of [
      withEars(),
      withEars({ hair: false }, { silhouetteRatio: 0.9 }),
      withEars({ hair: false }, { silhouetteRatio: shellRatio(0.8) }),
    ]) {
      const ears = frame.ears!;
      const ear = withoutHead(m);
      const rest = landVertices(m, "face");
      for (const ax of [-30, 30]) {
        const s = Math.sign(ax);
        const pose = X30(ax);
        const v = landVertices(m, "face", pose);
        let tucked = 0;
        for (let i = 0; i < rest.length / 2; i++) {
          const [x, y] = [rest[i * 2], rest[i * 2 + 1]];
          const u = x - frame.axisX;
          // On the ear island's rows — it runs 2 px past the band either way,
          // its end rows here at y 36 and 135 — inside the head's own
          // outline, on the far side.
          if (y < ears.bottom - 2 || y > ears.top + 2) continue;
          if (Math.abs(u) >= ears.attachAt(y) - 1) continue;
          if (s * u <= 0) continue;
          // Where the head island's own point on that outline lands.
          const edge = landedXAt(
            m,
            "face",
            frame.axisX + s * ears.attachAt(y),
            y,
            pose,
          );
          expect(
            s * (v[i * 2] - edge),
            `(${x}, ${y}) at AngleX ${ax}`,
          ).toBeLessThanOrEqual(1e-3);
          // The ear island's own inner column, EAR_TUCK (0.08 hh) inside the
          // line — not only the head's vertices there.
          const tuck = ears.attachAt(y) - 0.08 * frame.hh;
          if (Math.abs(Math.abs(u) - tuck) < 0.05) tucked++;
        }
        expect(tucked).toBeGreaterThan(0);
        // The ear's own point on the line goes no further than the head's.
        for (let y = ears.bottom - 2; y <= ears.top + 2; y += 5) {
          const at = frame.axisX + s * ears.attachAt(y);
          expect(
            s *
              (landedXAt(ear, "face", at, y, pose) -
                landedXAt(m, "face", at, y, pose)),
            `row ${y} at AngleX ${ax}`,
          ).toBeLessThanOrEqual(0.1);
        }
      }
    }
  });

  it("moves the far ear's tucked strip no further than the head over it", () => {
    // Without hair at a shellScale of 0.94 the plate narrows on the turn
    // while the head still moves well past the ear's held outer edge on the
    // line under it; at 0.8 (the narrowest) the solve limits the narrowing
    // to where the head there does not move back off that edge. With the
    // edge held (`earFar` 0) the head covers the strip's inner end with room
    // to spare in both, so the cap on the strip does not bind here: this
    // guards it for an outer edge that moves.
    for (const { m, frame } of [
      withEars(),
      withEars({ hair: false }, { silhouetteRatio: shellRatio(0.94) }),
      withEars({ hair: false }, { silhouetteRatio: shellRatio(0.8) }),
    ]) {
      const ears = frame.ears!;
      const ear = withoutHead(m);
      const tuck = 0.08 * frame.hh;
      // The keyforms round each offset to 1e-4 of the plate's box.
      const eps = 1e-4 * m.parts.find((p) => p.id === "face")!.width;
      const rest = landVertices(m, "face");
      for (const ax of [-30, -15, 15, 30]) {
        const s = Math.sign(ax);
        const pose = X30(ax);
        const v = landVertices(m, "face", pose);
        for (let i = 0; i < rest.length / 2; i++) {
          const [x, y] = [rest[i * 2], rest[i * 2 + 1]];
          const u = x - frame.axisX;
          // On the ear island's rows, inside the head's own outline, on the
          // far side; the head island is drawn last, so the read is its.
          if (y < ears.bottom - 2 || y > ears.top + 2) continue;
          if (Math.abs(u) >= ears.attachAt(y) - 1) continue;
          if (s * u <= 0) continue;
          expect(
            s * (v[i * 2] - landedXAt(m, "face", x, y, pose)),
            `(${x}, ${y}) at AngleX ${ax}`,
          ).toBeLessThanOrEqual(eps);
        }
        // The ear island's own point at its inner end on row 85.
        const at = frame.axisX + s * (ears.attachAt(85) - tuck);
        expect(
          s *
            (landedXAt(ear, "face", at, 85, pose) -
              landedXAt(m, "face", at, 85, pose)),
          `row 85 at AngleX ${ax}`,
        ).toBeLessThanOrEqual(eps);
      }
    }
  });

  it("narrows a fitted silhouette only as far as the head does not move back off the far ear", () => {
    // Without hair at a shellScale of 0.8 the plate would narrow so much
    // that on the line under the ear the head moved back off the ear's held
    // outer edge: the solve stops short, and says so.
    const { m, frame, report } = withEars(
      { hair: false },
      { silhouetteRatio: shellRatio(0.8) },
    );
    expect(report.clamped).toContain("silhouetteRatio");
    expect(report.achieved.silhouetteRatio).toBeGreaterThan(
      shellRatio(0.8) + 0.01,
    );
    const ears = frame.ears!;
    const ear = withoutHead(m);
    for (const ax of [-30, 30]) {
      const s = Math.sign(ax);
      // The outer edge keeps its TURN.earFar of the plate's slide (row 85):
      // it holds.
      const far = frame.axisX + s * (ears.outer - 0.5);
      const rim = landedXAt(m, "face", far, 85, X30(ax)) - far;
      const plate = landedXAt(m, "face", 0.5, 85, X30(ax)) - 0.5;
      expect(rim / plate, `AngleX ${ax}`).toBeCloseTo(TURN.earFar, 2);
      // ... and the ear narrows, to no less than TURN.earFarScale, and never
      // widens.
      for (let y = ears.bottom; y <= ears.top; y += 5) {
        const d0 = ears.attachAt(y) + 2;
        const d1 = ears.outer - 2;
        const at = (d: number) =>
          landedXAt(ear, "face", frame.axisX + s * d, y, X30(ax));
        const span = (s * (at(d1) - at(d0))) / (d1 - d0);
        const label = `row ${y} at AngleX ${ax}: ${span}`;
        expect(span, label).toBeLessThanOrEqual(1 + 1e-3);
        expect(span, label).toBeGreaterThanOrEqual(TURN.earFarScale - 0.01);
      }
    }
    // Where the head already covers it, the fit is the caller's.
    const covered = withEars(
      { hair: false },
      { silhouetteRatio: shellRatio(0.94) },
    );
    expect(covered.report.clamped).not.toContain("silhouetteRatio");
    expect(covered.report.achieved.silhouetteRatio).toBeCloseTo(
      shellRatio(0.94),
      2,
    );
  });
});
