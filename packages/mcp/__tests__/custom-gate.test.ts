/**
 * The custom-part gate on a hand-built bust: a 200 px face, a `hair_back`
 * anchor and a strip hung from it by a tie. Warps are written by hand as a
 * bake would write them, so each case names what it does to the strip.
 */

import { describe, expect, it } from "vitest";
import { rigidResidual } from "@ikijs/editor";
import { landParts } from "@ikijs/engine";
import { parseIkiModel, type IkiModel } from "@ikijs/format";
import {
  checkCustomGate,
  formatCustomGate,
  type CustomGatePart,
  type CustomGateReport,
} from "../src/custom-gate";
import { toCanvas, type PaintRuns } from "../src/probe";

const CANVAS = 400;
/** The strip: canvas x 190..210, y 150..250. */
const STRIP = { x0: 190, x1: 210, y0: 150, y1: 250 };
const TIE: [number, number] = [200, 160];

interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
const BIG: Rect = { x0: 100, x1: 300, y0: 100, y1: 300 };

const rectPaint = (r: Rect): PaintRuns => ({
  y0: r.y0,
  rows: Array.from({ length: r.y1 - r.y0 }, () => [[r.x0, r.x1]]),
});

/** A quad part over `r`, meshed in rows at the given fractions of its height
 *  from the top, with warps `{ param, stop, dx[] }` giving a canvas-px shift
 *  per row at ±stop (x only, mirrored at -stop). */
interface Warp {
  param: string;
  stop: number;
  dx: number[];
}
function meshPart(
  id: string,
  r: Rect,
  order: number,
  rows: number[],
  warps: Warp[],
) {
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  const vertices = rows.flatMap((f) => [-0.5, 0.5 - f, 0.5, 0.5 - f]);
  const indices: number[] = [];
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const uvs = rows.flatMap((f) => [0, f, 1, f]);
  return {
    id,
    color: [1, 1, 1, 1],
    width: w,
    height: h,
    transform: {
      x: (r.x0 + r.x1) / 2 - CANVAS / 2,
      y: CANVAS / 2 - (r.y0 + r.y1) / 2,
    },
    order,
    mesh: { vertices, uvs, indices },
    ...(warps.length === 0
      ? {}
      : {
          warps: warps.map((wp) => {
            const at = (sign: number) =>
              wp.dx.flatMap((dx) => [(sign * dx) / w, 0, (sign * dx) / w, 0]);
            return {
              parameter: wp.param,
              keyforms: [
                { value: -wp.stop, offsets: at(-1) },
                { value: 0, offsets: at(0) },
                { value: wp.stop, offsets: at(1) },
              ],
            };
          }),
        }),
  };
}

interface Case {
  anchor?: Rect;
  anchorWarps?: Warp[];
  stripRows?: number[];
  stripWarps?: Warp[];
  /** Strip drawn below its anchor. */
  stripBelow?: boolean;
}
function bust(c: Case): IkiModel {
  const anchor = c.anchor ?? BIG;
  return parseIkiModel({
    version: 1,
    name: "bust",
    canvas: { width: CANVAS, height: CANVAS },
    parameters: [
      { id: "ParamAngleX", min: -30, max: 30, default: 0 },
      { id: "ParamHairBackSway", min: -20, max: 20, default: 0 },
    ],
    parts: [
      meshPart("face", { x0: 100, x1: 300, y0: 100, y1: 300 }, 0, [0, 1], []),
      meshPart(
        "hair_back",
        anchor,
        c.stripBelow ? 2 : 1,
        [0, 1],
        c.anchorWarps ?? [],
      ),
      meshPart(
        "strip",
        STRIP,
        c.stripBelow ? 1 : 2,
        c.stripRows ?? [0, 1],
        c.stripWarps ?? [],
      ),
    ],
  });
}

const part = (extra: Partial<CustomGatePart> = {}): CustomGatePart[] => [
  { id: "strip", anchor: "hair_back", tie: TIE, ...extra },
];
const paints = (anchor: Rect = BIG) =>
  new Map([
    ["hair_back", rectPaint(anchor)],
    ["strip", rectPaint(STRIP)],
  ]);
const gate = (
  c: Case,
  extra: Partial<CustomGatePart> = {},
  anchor: Rect = c.anchor ?? BIG,
): CustomGateReport => checkCustomGate(bust(c), part(extra), paints(anchor));

/** The anchor sways 20 px right at ParamHairBackSway 20. */
const SWAY_ANCHOR: Warp[] = [
  { param: "ParamHairBackSway", stop: 20, dx: [20, 20] },
];

describe("checkCustomGate: the tie, folds and slide", () => {
  it("fails TIE where the anchor sways and the strip does not follow", () => {
    const r = gate({ anchorWarps: SWAY_ANCHOR });
    expect(r.ok).toBe(false);
    const p = r.parts[0];
    expect(p.tie.pass).toBe(false);
    expect(p.tie.px).toBeCloseTo(20, 3);
    expect(p.tie.pose).toBe("ParamHairBackSway=-20");
    expect(r.failed).toContain("strip TIE");
    expect(formatCustomGate(r).at(-1)).toMatch(
      /^CUSTOM GATE FAIL: .*strip TIE/,
    );
  });

  it("passes when the strip is baked to follow the anchor", () => {
    const r = gate({
      anchorWarps: SWAY_ANCHOR,
      stripWarps: [{ param: "ParamHairBackSway", stop: 20, dx: [20, 20] }],
    });
    expect(r.failed).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.parts[0].tie.px!).toBeLessThan(0.01);
    const lines = formatCustomGate(r);
    expect(lines.at(-1)).toBe("CUSTOM GATE pass");
    expect(
      lines.some((l) => /^CUSTOM strip TIP ParamHairBackSway: /.test(l)),
    ).toBe(true);
    const tip = r.parts[0].tip[0];
    expect(tip.ends.map((e) => e.value)).toEqual([-20, 20]);
    expect(tip.travel).toBeCloseTo(40, 2);
  });

  it("fails FOLDS at the strip's own stop when a bake flips it", () => {
    const model = bust({
      anchorWarps: SWAY_ANCHOR,
      stripWarps: [{ param: "ParamHairBackSway", stop: 20, dx: [20, 20] }],
    });
    const strip = model.parts.find((p) => p.id === "strip")!;
    const w = strip.warps![0];
    // y offsets, fractions of the height, model y up: both bottom vertices
    // rise 1.5 heights at +20 and fall the same at -20.
    for (const k of w.keyforms) {
      const s = Math.sign(k.value);
      k.offsets[5] = 1.5 * s;
      k.offsets[7] = 1.5 * s;
    }
    expect(
      checkCustomGate(bust({ anchorWarps: SWAY_ANCHOR }), part(), paints())
        .parts[0].folds.pass,
    ).toBe(true);
    const flipped = checkCustomGate(model, part(), paints());
    expect(flipped.parts[0].folds.pass).toBe(false);
    expect(flipped.parts[0].folds.ratio).toBeLessThanOrEqual(0);
    expect(flipped.parts[0].folds.pose).toMatch(/^ParamHairBackSway=(-)?20$/);
    expect(flipped.failed).toContain("strip FOLDS");
  });

  it("fails SLIDE when the tie slides past 0.1 face widths in a turn", () => {
    const r = gate({
      stripWarps: [{ param: "ParamAngleX", stop: 30, dx: [30, 30] }],
    });
    const p = r.parts[0];
    expect(p.tie.pass).toBe(true);
    expect(p.slide.slide.pass).toBe(false);
    expect(p.slide.slide.px).toBeCloseTo(30, 3);
    expect(p.slide.onAnchor.pass).toBe(true);
    expect(r.failed).toEqual(["strip SLIDE"]);
  });

  it("fails SLIDE when the tie slides off the anchor's paint, inside the slide limit", () => {
    const anchor: Rect = { x0: 100, x1: 205, y0: 100, y1: 300 };
    const r = gate(
      {
        anchor,
        stripWarps: [{ param: "ParamAngleX", stop: 30, dx: [10, 10] }],
      },
      {},
      anchor,
    );
    const p = r.parts[0];
    expect(p.slide.slide.pass).toBe(true);
    expect(p.slide.onAnchor.pass).toBe(false);
    expect(p.slide.onAnchor.px!).toBeGreaterThan(3);
    expect(r.failed).toEqual(["strip SLIDE"]);
  });

  it("fails TIE with its reason when the tie is on neither mesh", () => {
    const r = checkCustomGate(
      bust({}),
      [{ id: "strip", anchor: "hair_back", tie: [50, 50] }],
      paints(),
    );
    const p = r.parts[0];
    expect(p.tie.pass).toBe(false);
    expect(p.tie.value).toBeNull();
    expect(p.tie.reason).toMatch(
      /no point of the ring around the tie lies on both strip and hair_back/,
    );
    expect(formatCustomGate(r).join("\n")).toMatch(
      /TIE: .*FAIL: no point of the ring/,
    );
  });

  it("takes options.poses in place of the default set", () => {
    const c = { anchorWarps: SWAY_ANCHOR };
    const only = checkCustomGate(bust(c), part(), paints(), {
      poses: [{ name: "rest", values: {} }],
    });
    expect(only.ok).toBe(true);
    expect(only.poses).toBe(1);
  });
});

describe("checkCustomGate: limits, just inside and just outside", () => {
  // The face is 200 px: TIE 1 px, SLIDE 20 px, FOLDS 0.1.
  const follow = (dx: number): Case => ({
    anchorWarps: SWAY_ANCHOR,
    stripWarps: [{ param: "ParamHairBackSway", stop: 20, dx: [dx, dx] }],
  });
  it("TIE: a 0.8 px gap passes and a 1.3 px gap fails", () => {
    const inside = gate(follow(20.8)).parts[0].tie;
    expect(inside.px).toBeCloseTo(0.8, 3);
    expect(inside.value).toBeCloseTo(0.8 / 200, 6);
    expect(inside.pass).toBe(true);
    const outside = gate(follow(21.3)).parts[0].tie;
    expect(outside.px).toBeCloseTo(1.3, 3);
    expect(outside.pass).toBe(false);
  });

  it("SLIDE: a 19 px slide passes and a 21 px slide fails", () => {
    const slide = (dx: number) =>
      gate({ stripWarps: [{ param: "ParamAngleX", stop: 30, dx: [dx, dx] }] })
        .parts[0].slide.slide;
    expect(slide(19).px).toBeCloseTo(19, 3);
    expect(slide(19).pass).toBe(true);
    expect(slide(21).px).toBeCloseTo(21, 3);
    expect(slide(21).pass).toBe(false);
  });

  it("FOLDS: a collapse between 0 and 0.1 fails, 0.15 passes", () => {
    // The strip's bottom edge rises by this share of its height at +20.
    const squash = (rise: number) => {
      const model = bust({
        anchorWarps: SWAY_ANCHOR,
        stripWarps: [{ param: "ParamHairBackSway", stop: 20, dx: [20, 20] }],
      });
      const w = model.parts.find((p) => p.id === "strip")!.warps![0];
      for (const k of w.keyforms) {
        k.offsets[5] = rise * Math.sign(k.value);
        k.offsets[7] = rise * Math.sign(k.value);
      }
      return checkCustomGate(model, part(), paints()).parts[0].folds;
    };
    const collapsed = squash(0.95);
    expect(collapsed.ratio).toBeCloseTo(0.05, 3);
    expect(collapsed.pass).toBe(false);
    expect(collapsed.reason).toBe("a collapse");
    const thin = squash(0.85);
    expect(thin.ratio).toBeCloseTo(0.15, 3);
    expect(thin.pass).toBe(true);
  });
});

describe("checkCustomGate: EXPOSED", () => {
  // Rows at the tie's ring: 150 (the root), 158, 162, 250 (fractions of 100).
  const ROWS = [0, 0.08, 0.12, 1];
  const FOLLOW = (param: string, stop: number, root: number): Warp => ({
    param,
    stop,
    dx: [root, 20, 20, 20],
  });

  it("counts the hidden patch and, at rest alone, shows none of it", () => {
    const r = checkCustomGate(bust({}), part(), paints(), {
      poses: [{ name: "rest", values: {} }],
    });
    expect(r.parts[0].exposed.hiddenPx).toBeGreaterThan(500);
    expect(r.parts[0].exposed.noTurn.px2).toBe(0);
    expect(r.parts[0].exposed.noTurn.pose).toBe("rest");
    expect(r.parts[0].exposed.pass).toBe(true);
  });

  it("fails a root swung off the patch where the head does not turn, though the tie holds", () => {
    // The anchor sways 20 px; the strip's root row stays put, the rows from
    // the ring down follow.
    const r = gate({
      anchorWarps: SWAY_ANCHOR,
      stripRows: ROWS,
      stripWarps: [FOLLOW("ParamHairBackSway", 20, 0)],
    });
    const p = r.parts[0];
    expect(p.tie.pass).toBe(true);
    expect(p.folds.pass).toBe(true);
    expect(p.exposed.pass).toBe(false);
    // The root band's shear: half of 20 px x 8 px.
    expect(p.exposed.noTurn.px2).toBeCloseTo(80, 3);
    expect(p.exposed.noTurn.value).toBeCloseTo(80 / 200 ** 2, 8);
    expect(p.exposed.noTurn.pose).toMatch(/^ParamHairBackSway=(-)?20$/);
    expect(r.failed).toEqual(["strip EXPOSED"]);
  });

  it("reports the same swing on ParamAngleX and passes", () => {
    const r = gate({
      anchorWarps: [{ param: "ParamAngleX", stop: 30, dx: [20, 20] }],
      stripRows: ROWS,
      stripWarps: [FOLLOW("ParamAngleX", 30, 0)],
    });
    const p = r.parts[0];
    expect(p.exposed.noTurn.value).toBe(0);
    expect(p.exposed.turning).not.toBeNull();
    expect(p.exposed.turning!.px2).toBeCloseTo(80, 3);
    expect(p.exposed.turning!.value).toBeCloseTo(80 / 200 ** 2, 8);
    expect(p.exposed.pass).toBe(true);
    expect(r.failed).toEqual([]);
    expect(formatCustomGate(r).join("\n")).toMatch(
      /where it turns: max \d+ px²/,
    );
  });

  it("reads a strip drawn below its anchor the other way round", () => {
    // The anchor is a patch only as wide as the strip, so a sway uncovers the
    // strip's own hidden root.
    const patch: Rect = { x0: 190, x1: 230, y0: 100, y1: 200 };
    const r = gate(
      { anchor: patch, stripBelow: true, anchorWarps: SWAY_ANCHOR },
      {},
      patch,
    );
    const p = r.parts[0];
    expect(p.exposed.pass).toBe(false);
    // Every hidden pixel shows.
    expect(p.exposed.noTurn.px2).toBe(p.exposed.hiddenPx);
    // The anchor moves, the strip stays: the tie comes apart too.
    expect(r.failed).toContain("strip EXPOSED");
  });
});

describe("checkCustomGate: robustness and text", () => {
  it("measures a huge bake without building a grid to match", () => {
    const r = gate({
      anchorWarps: [{ param: "ParamHairBackSway", stop: 20, dx: [1e9, 1e9] }],
      stripWarps: [{ param: "ParamHairBackSway", stop: 20, dx: [-1e9, -1e9] }],
    });
    expect(r.ok).toBe(false);
  });

  it("says no pose turns the head when none does, and gives limits in px", () => {
    const r = checkCustomGate(bust({}), part({ rigid: true }), paints(), {
      poses: [{ name: "rest", values: {} }],
    });
    const lines = formatCustomGate(r);
    expect(lines.find((l) => /SLIDE/.test(l))).toMatch(
      /no pose turns the head/,
    );
    expect(lines.find((l) => /TIE/.test(l))).toMatch(/1\.0 px\)/);
    expect(lines.find((l) => /RIGID/.test(l))).toMatch(/0\.5 px\)/);
  });
});

describe("checkCustomGate: RIGID", () => {
  const ROWS = [0, 0.5, 1];
  it("reads 0 for a rigid part baked as a translation and passes", () => {
    const r = gate(
      {
        anchorWarps: SWAY_ANCHOR,
        stripRows: ROWS,
        stripWarps: [
          { param: "ParamHairBackSway", stop: 20, dx: [20, 20, 20] },
        ],
      },
      { rigid: true },
    );
    const p = r.parts[0];
    expect(p.rigid!.pass).toBe(true);
    expect(p.rigid!.px!).toBeLessThan(0.01);
    expect(r.ok).toBe(true);
    expect(
      formatCustomGate(r).some((l) => /^CUSTOM strip RIGID: /.test(l)),
    ).toBe(true);
  });

  it("fails the same model with a shear written into its warp by hand", () => {
    const r = gate(
      {
        anchorWarps: SWAY_ANCHOR,
        stripRows: ROWS,
        stripWarps: [{ param: "ParamHairBackSway", stop: 20, dx: [20, 10, 0] }],
      },
      { rigid: true },
    );
    expect(r.parts[0].rigid!.pass).toBe(false);
    expect(r.failed).toContain("strip RIGID");
  });

  it("passes a bend under the limit and prints the residual in px as rigidResidual reads it", () => {
    // 0.6 px out of line on the middle row, on a 200 px face: the limit is
    // 0.0025 face widths, 0.5 px.
    const c = {
      anchorWarps: SWAY_ANCHOR,
      stripRows: ROWS,
      stripWarps: [
        { param: "ParamHairBackSway", stop: 20, dx: [20, 20.6, 20] },
      ],
    };
    const r = gate(c, { rigid: true });
    const rigid = r.parts[0].rigid!;
    const model = bust(c);
    const at = (v: Record<string, number>) =>
      toCanvas(model, landParts(model, v, ["strip"]).get("strip")!);
    const points = (a: Float64Array): [number, number][] =>
      Array.from({ length: a.length / 2 }, (_, i) => [a[i * 2], a[i * 2 + 1]]);
    const expected = rigidResidual(
      points(at({})),
      points(at({ ParamHairBackSway: 20 })),
    );
    expect(expected).toBeGreaterThan(0.05);
    expect(rigid.px!).toBeCloseTo(expected, 3);
    expect(rigid.value!).toBeCloseTo(expected / 200, 5);
    expect(rigid.pass).toBe(true);
  });

  it("is absent for a part that is not rigid", () => {
    expect(gate({}).parts[0].rigid).toBeUndefined();
  });
});
