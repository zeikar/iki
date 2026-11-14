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
  /** More stops, each mirrored at its negative as `stop` is. */
  also?: { stop: number; dx: number[] }[];
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
            const at = (dxs: number[], sign: number) =>
              dxs.flatMap((dx) => [(sign * dx) / w, 0, (sign * dx) / w, 0]);
            const stops = [
              { stop: wp.stop, dx: wp.dx },
              ...(wp.also ?? []),
            ].sort((a, b) => a.stop - b.stop);
            return {
              parameter: wp.param,
              keyforms: [
                ...[...stops]
                  .reverse()
                  .map((k) => ({ value: -k.stop, offsets: at(k.dx, -1) })),
                { value: 0, offsets: at(wp.dx, 0) },
                ...stops.map((k) => ({ value: k.stop, offsets: at(k.dx, 1) })),
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
  /** What hides the strip, written by hand. */
  occlusion?: { by: string[]; parameter: string; stops: Stop[] };
  /** A part added after the strip, such as a small occluder. */
  extra?: ReturnType<typeof meshPart>;
  /** Changes the built anchor, to make it fade. */
  anchorEdit?: (anchor: Record<string, unknown>) => void;
}
interface Stop {
  value: number;
  amount: number;
}
function bust(c: Case): IkiModel {
  const anchor = c.anchor ?? BIG;
  const hairBack: Record<string, unknown> = meshPart(
    "hair_back",
    anchor,
    c.stripBelow ? 2 : 1,
    [0, 1],
    c.anchorWarps ?? [],
  );
  c.anchorEdit?.(hairBack);
  return parseIkiModel({
    version: 1,
    name: "bust",
    canvas: { width: CANVAS, height: CANVAS },
    parameters: [
      { id: "ParamAngleX", min: -30, max: 30, default: 0 },
      { id: "ParamAngleY", min: -30, max: 30, default: 0 },
      { id: "ParamHairBackSway", min: -20, max: 20, default: 0 },
    ],
    parts: [
      meshPart("face", { x0: 100, x1: 300, y0: 100, y1: 300 }, 0, [0, 1], []),
      hairBack,
      {
        ...meshPart(
          "strip",
          STRIP,
          c.stripBelow ? 1 : 2,
          c.stripRows ?? [0, 1],
          c.stripWarps ?? [],
        ),
        ...(c.occlusion === undefined ? {} : { occlusion: c.occlusion }),
      },
      ...(c.extra === undefined ? [] : [c.extra]),
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

  it("fails FOLDS at a pair of interior stops that the outermost stops never reach", () => {
    const model = bust({});
    const strip = model.parts.find((p) => p.id === "strip")!;
    // Both bottom vertices rise 0.6 heights at 10 and are back at rest at the
    // ends, so each parameter alone folds nothing (ratio 0.4) and the pair's
    // sum, 1.2 heights, flips the strip.
    const rise = (y: number) => [0, 0, 0, 0, 0, y, 0, y];
    strip.warps = ["ParamHairBackSway", "ParamAngleX"].map((parameter) => ({
      parameter,
      keyforms: [
        { value: -20, offsets: rise(0) },
        { value: 0, offsets: rise(0) },
        { value: 10, offsets: rise(0.6) },
        { value: 20, offsets: rise(0) },
      ],
    }));
    const r = checkCustomGate(model, part(), paints());
    expect(r.parts[0].folds.pass).toBe(false);
    expect(r.parts[0].folds.ratio).toBeLessThan(0);
    expect(r.parts[0].folds.pose).toBe("ParamAngleX=10 ParamHairBackSway=10");
    expect(r.failed).toContain("strip FOLDS");
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

describe("checkCustomGate: what an occlusion hides", () => {
  // The fixture's pose set: rest, three parameters at min and max (6), the four
  // ParamAngleX x ParamAngleY corners = 11. A part baked or occluded on a
  // parameter at +-15 and +-30 adds the two +-15 poses on their own = 13; the
  // occlusion's +-10 stops (DEEP, LATE) add two more: DEEP with its +-15 = 15,
  // LATE (+-10, +-30) = 13.
  const SLIDE_AWAY: Warp = { param: "ParamAngleX", stop: 30, dx: [30, 30] };
  /** 5 px at +-15, inside the 20 px limit, 30 px at +-30. */
  const EARLY: Warp = {
    param: "ParamAngleX",
    stop: 15,
    dx: [5, 5],
    also: [{ stop: 30, dx: [30, 30] }],
  };
  /** Hidden from +-15 out (amount 1 there and at +-30), clear inside +-10. */
  const DEEP = (parameter: string, top: number): Case["occlusion"] => ({
    by: ["hair_back"],
    parameter,
    stops: [
      { value: -30, amount: top },
      { value: -15, amount: top },
      { value: -10, amount: 0 },
      { value: 10, amount: 0 },
      { value: 15, amount: top },
      { value: 30, amount: top },
    ],
  });
  /** Reaches amount 1 only at the end stops. */
  const LATE = (parameter: string): Case["occlusion"] => ({
    by: ["hair_back"],
    parameter,
    stops: [
      { value: -30, amount: 1 },
      { value: -10, amount: 0 },
      { value: 10, amount: 0 },
      { value: 30, amount: 1 },
    ],
  });
  const hides = (c: Case, extra: Partial<CustomGatePart> = {}) =>
    checkCustomGate(
      bust(c),
      part({ occludedBy: ["hair_back"], ...extra }),
      paints(c.anchor ?? BIG),
    );
  const hiddenLine = (r: CustomGateReport) =>
    formatCustomGate(r).find((l) => /HIDDEN:/.test(l))!;

  it("still fails TIE at rest where the amount is 0, though the tie lies on the anchor's paint", () => {
    const r = hides({
      anchorWarps: SWAY_ANCHOR,
      occlusion: {
        by: ["hair_back"],
        parameter: "ParamAngleX",
        stops: [
          { value: 0, amount: 0 },
          { value: 30, amount: 1 },
        ],
      },
    });
    expect(r.parts[0].tie.pass).toBe(false);
    expect(r.parts[0].tie.px).toBeCloseTo(20, 3);
    expect(r.parts[0].tie.pose).toMatch(/^ParamHairBackSway=-?20$/);
    expect(r.failed).toContain("strip TIE");
    expect(r.parts[0].hidden!.atRest).toBe(0);
    // The amount is 0 at the sampled 0, so +30's stretch is not fully hidden.
    expect(r.parts[0].hidden!.leftOut).toBe(0);
    expect(r.parts[0].hidden!.poses).toBe(11);
  });

  it("passes a slide that is large only where the part is fully hidden, and counts those poses", () => {
    const r = hides({ stripWarps: [EARLY], occlusion: DEEP("ParamAngleX", 1) });
    expect(r.failed).toEqual([]);
    const h = r.parts[0].hidden!;
    // ParamAngleX at +-30: two alone and four corners. +-15 stays read.
    expect(h.leftOut).toBe(6);
    expect(h.leftOutTurning).toBe(6);
    expect(h.poses).toBe(15);
    expect(h.cover).toEqual(["hair_back"]);
    expect(h.atRest).toBe(0);
    expect(h.below).toEqual({ leaves: -10, full: -15 });
    expect(h.above).toEqual({ leaves: 10, full: 15 });
    // ParamAngleX=-15, -10, 10 and 15 are the poses that turn the head and
    // are read.
    expect(r.parts[0].slide.turningPoses).toBe(4);
    expect(r.parts[0].slide.slide.px).toBeCloseTo(5, 3);
    const line = hiddenLine(r);
    expect(line).toMatch(
      /below 0 the amount leaves 0 at -10 and reaches 1 at -15/,
    );
    expect(line).toMatch(
      /left out of TIE and SLIDE: 6 of 15 poses \(reported, no limit\)/,
    );
  });

  it("samples the occlusion's stops: a bake key where the fade ends changes nothing", () => {
    // Linear travel to 30 px at +-30, hidden from +-15 on. Without a bake key
    // at 15 the reading there is still 15 px (inside the 20 px limit) and the
    // +-30 poses are left out, as with the redundant key.
    const bare = hides({
      stripWarps: [SLIDE_AWAY],
      occlusion: DEEP("ParamAngleX", 1),
    });
    const keyed = hides({
      stripWarps: [
        {
          param: "ParamAngleX",
          stop: 15,
          dx: [15, 15],
          also: [{ stop: 30, dx: [30, 30] }],
        },
      ],
      occlusion: DEEP("ParamAngleX", 1),
    });
    for (const r of [bare, keyed]) {
      expect(r.failed).toEqual([]);
      expect(r.parts[0].slide.slide.px).toBeCloseTo(15, 3);
      expect(r.parts[0].hidden!.leftOut).toBe(6);
      expect(r.parts[0].hidden!.poses).toBe(15);
    }
  });

  it("fails SLIDE where the amount reaches 1 only at the end stop, the stretch before it being drawn", () => {
    const r = hides({
      stripWarps: [{ param: "ParamAngleX", stop: 30, dx: [60, 60] }],
      occlusion: LATE("ParamAngleX"),
    });
    expect(r.failed).toContain("strip SLIDE");
    expect(r.parts[0].slide.slide.px).toBeCloseTo(60, 3);
    // +-30's stretch to the sampled 0 starts at amount 0: nothing is left out.
    expect(r.parts[0].hidden!.leftOut).toBe(0);
    expect(r.parts[0].hidden!.poses).toBe(13);
  });

  it("fails SLIDE for the same slide with the top amount 0.9", () => {
    const r = hides({
      stripWarps: [EARLY],
      occlusion: DEEP("ParamAngleX", 0.9),
    });
    expect(r.failed).toContain("strip SLIDE");
    expect(r.parts[0].slide.slide.px).toBeCloseTo(30, 3);
    expect(r.parts[0].hidden!.leftOut).toBe(0);
    expect(r.parts[0].hidden!.poses).toBe(15);
  });

  it("fails SLIDE at amount 1 where the tie lands off the occluder's paint", () => {
    const anchor: Rect = { x0: 100, x1: 225, y0: 100, y1: 300 };
    const r = hides({
      anchor,
      stripWarps: [EARLY],
      occlusion: DEEP("ParamAngleX", 1),
    });
    expect(r.failed).toContain("strip SLIDE");
    expect(r.parts[0].slide.slide.pass).toBe(false);
    // The ring lands at 228..232 at +30, off the paint, so +30's poses are
    // read; -30's (alone and two corners) stay under it and are left out.
    expect(r.parts[0].slide.slide.pose).toMatch(/^ParamAngleX=30/);
    expect(r.parts[0].hidden!.leftOut).toBe(3);
    expect(r.parts[0].hidden!.poses).toBe(15);
  });

  it("fails SLIDE where a ring point lies off the part's mesh, though it would be left out otherwise", () => {
    // The ring is +-2 px on this 200 px face: y 149 is above the strip (150).
    const r = hides(
      { stripWarps: [EARLY], occlusion: DEEP("ParamAngleX", 1) },
      { tie: [200, 151] },
    );
    expect(r.parts[0].hidden!.leftOut).toBe(0);
    expect(r.failed).toContain("strip SLIDE");
  });

  it("gives no cover from an occluder that fades, by binding or by alpha", () => {
    const fade = (anchorEdit: Case["anchorEdit"]) =>
      hides({
        stripWarps: [EARLY],
        occlusion: DEEP("ParamAngleX", 1),
        anchorEdit,
      });
    const byBinding = fade((a) => {
      a.bindings = [
        {
          parameter: "ParamHairBackSway",
          channel: "opacity",
          from: 1,
          to: 0.5,
        },
      ];
    });
    const byAlpha = fade((a) => {
      a.color = [1, 1, 1, 0.9];
    });
    const byTransform = fade((a) => {
      (a.transform as { opacity?: number }).opacity = 0.9;
    });
    for (const r of [byBinding, byAlpha, byTransform]) {
      expect(r.failed).toContain("strip SLIDE");
      expect(r.parts[0].hidden!.cover).toEqual([]);
      expect(r.parts[0].hidden!.leftOut).toBe(0);
      expect(hiddenLine(r)).toMatch(/cover from none of them \(the rest fade/);
    }
  });

  describe("EXPOSED, keyed on ParamAngleY", () => {
    const EARLY_Y: Warp = {
      param: "ParamAngleY",
      stop: 15,
      dx: [0.5, 0.5],
      also: [{ stop: 30, dx: [30, 30] }],
    };

    it("does not count hidden art under the cover where the part is fully hidden, and the pose is left out of TIE", () => {
      const r = hides({
        stripWarps: [EARLY_Y],
        occlusion: DEEP("ParamAngleY", 1),
      });
      expect(r.parts[0].exposed.hiddenPx).toBeGreaterThan(500);
      expect(r.failed).toEqual([]);
      // ParamAngleY at +-30: two alone and four corners.
      expect(r.parts[0].hidden!.leftOut).toBe(6);
      expect(r.parts[0].hidden!.poses).toBe(15);
    });

    it("fails where the amount reaches 1 only at the end stop", () => {
      const r = hides({
        stripWarps: [{ param: "ParamAngleY", stop: 30, dx: [30, 30] }],
        occlusion: LATE("ParamAngleY"),
      });
      expect(r.parts[0].exposed.pass).toBe(false);
      expect(r.parts[0].exposed.noTurn.px2!).toBeGreaterThan(300);
      expect(r.failed).toContain("strip EXPOSED");
      expect(r.parts[0].hidden!.leftOut).toBe(0);
      expect(r.parts[0].hidden!.poses).toBe(13);
    });

    it("still counts hidden art that shows outside the cover, while TIE leaves that pose out", () => {
      // A small occluder, moving with the strip, over the tie's ring and
      // little else; the anchor is not an occluder.
      const small: Rect = { x0: 185, x1: 215, y0: 155, y1: 175 };
      const r = checkCustomGate(
        bust({
          stripWarps: [EARLY_Y],
          extra: meshPart("hair_front", small, 3, [0, 1], [EARLY_Y]),
          occlusion: { ...DEEP("ParamAngleY", 1)!, by: ["hair_front"] },
        }),
        part({ occludedBy: ["hair_front"] }),
        new Map([...paints(), ["hair_front", rectPaint(small)]]),
      );
      const p = r.parts[0];
      expect(p.hidden!.cover).toEqual(["hair_front"]);
      // ParamAngleY at +-30: two alone and four corners.
      expect(p.hidden!.leftOut).toBe(6);
      expect(p.hidden!.poses).toBe(15);
      expect(p.exposed.pass).toBe(false);
      expect(p.exposed.noTurn.px2!).toBeGreaterThan(300);
      // The pose where EXPOSED fails moves the strip 30 px: TIE read at it
      // would be 30, so it is among the poses left out.
      expect(p.exposed.noTurn.pose).toMatch(/^ParamAngleY=-?30$/);
      expect(p.tie.pass).toBe(true);
      expect(p.tie.px!).toBeLessThan(1);
      expect(r.failed).toEqual(["strip EXPOSED"]);
    });
  });

  it("still fails FOLDS at a pose TIE leaves out", () => {
    const model = bust({
      stripWarps: [EARLY],
      occlusion: DEEP("ParamAngleX", 1),
    });
    const w = model.parts.find((p) => p.id === "strip")!.warps![0];
    // Only the +-30 stops flip the strip: those are the poses left out.
    for (const k of w.keyforms.filter((k) => Math.abs(k.value) === 30)) {
      k.offsets[5] = 1.5 * Math.sign(k.value);
      k.offsets[7] = 1.5 * Math.sign(k.value);
    }
    const r = checkCustomGate(
      model,
      part({ occludedBy: ["hair_back"] }),
      paints(),
    );
    expect(r.parts[0].hidden!.leftOut).toBe(6);
    expect(r.parts[0].folds.pass).toBe(false);
    expect(r.parts[0].folds.pose).toMatch(/^ParamAngleX=-?30/);
    expect(r.failed).toContain("strip FOLDS");
  });

  it("says so when every pose a line would read is left out", () => {
    // Hidden at every value: the default pose (amount 1, and 1 out to the
    // sampled -30 and 30) and all the others are left out, the anchor's sway
    // included.
    const r = hides({
      anchorWarps: SWAY_ANCHOR,
      occlusion: {
        by: ["hair_back"],
        parameter: "ParamAngleX",
        stops: [{ value: 0, amount: 1 }],
      },
    });
    expect(r.failed).toEqual([]);
    const h = r.parts[0].hidden!;
    expect(h.leftOut).toBe(11);
    expect(h.leftOutTurning).toBe(6);
    expect(h.readNoTurn).toBe(0);
    const lines = formatCustomGate(r);
    expect(lines.find((l) => /SLIDE/.test(l))).toBe(
      "CUSTOM strip SLIDE: every pose that turns the head is left out as hidden (see HIDDEN)  pass",
    );
    expect(lines.find((l) => /TIE/.test(l))).toBe(
      "CUSTOM strip TIE: every pose that does not turn the head is left out as hidden (see HIDDEN)  pass",
    );
  });

  it("reads a pose whose stretch toward the next sample is drawn, though the amount is 1 at the pose", () => {
    // Hidden at rest and out to 15, then appearing: 1 at 15, 0 at 30. At 22.5
    // the player draws the strip at alpha 0.5, slid 30 px.
    const r = hides({
      stripWarps: [
        {
          param: "ParamAngleX",
          stop: 15,
          dx: [60, 60],
          also: [{ stop: 30, dx: [0, 0] }],
        },
      ],
      occlusion: {
        by: ["hair_back"],
        parameter: "ParamAngleX",
        stops: [
          { value: 15, amount: 1 },
          { value: 30, amount: 0 },
        ],
      },
    });
    expect(r.failed).toContain("strip SLIDE");
    expect(r.parts[0].slide.slide.px).toBeCloseTo(60, 3);
    expect(r.parts[0].slide.slide.pose).toMatch(/^ParamAngleX=-?15/);
    const line = hiddenLine(r);
    expect(line).toMatch(/above 0 the amount is 1 at rest and leaves it at 15/);
    expect(line).toMatch(/below 0 the amount is 1 at rest and stays 1/);
  });

  it("leaves a part without occlusion as it was: no hidden key, no HIDDEN line", () => {
    const r = gate({ stripWarps: [SLIDE_AWAY] });
    expect("hidden" in r.parts[0]).toBe(false);
    expect(formatCustomGate(r).some((l) => /HIDDEN/.test(l))).toBe(false);
    // An occludedBy the model does not back with an occlusion excuses nothing.
    const stray = checkCustomGate(
      bust({ stripWarps: [SLIDE_AWAY] }),
      part({ occludedBy: ["hair_back"] }),
      paints(),
    );
    expect(stray.failed).toContain("strip SLIDE");
    expect("hidden" in stray.parts[0]).toBe(false);
  });
});
