import { describe, expect, it } from "vitest";
import { createLayerSetMeasurer } from "@ikijs/editor";
import type { LayerSetMeasurement, RgbaLayer } from "@ikijs/editor";

const CANVAS = 100;

type Rect = {
  x: number;
  y: number;
  w: number;
  h: number;
  alpha?: number;
  rgb?: [number, number, number];
};

/** A transparent CANVAS² straight-alpha RGBA layer with `rects` painted on it,
 *  skin-toned and opaque unless a rect gives its own colour or alpha; a later
 *  rect paints over an earlier one. */
function paint(rects: Rect[]): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(CANVAS * CANVAS * 4);
  for (const { x, y, w, h, alpha = 255, rgb = [200, 120, 60] } of rects) {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        rgba.set([...rgb, alpha], (yy * CANVAS + xx) * 4);
      }
    }
  }
  return rgba;
}

function layer(role: string, rects: Rect[]): RgbaLayer {
  return { role, fileName: `${role}.png`, rgba: paint(rects) };
}

// The face plate 20..79 square, the eyes' whites, irises on columns 33..38 and
// 61..66 / rows 36..41 (centre row 39, model y 10.5), a mouth, and a soft nose:
// a feather at alpha 77 (under ALPHA_OPAQUE, over ALPHA_BBOX_THRESHOLD) on
// 40..57 around an opaque 8×8 core at (46, 44). @ikijs/mcp's tools.test.ts
// paints the same set, with a hard nose, as PNGs.
function hairlessLayers(): RgbaLayer[] {
  return [
    layer("face", [{ x: 20, y: 20, w: 60, h: 60 }]),
    layer("eye_L", [{ x: 30, y: 35, w: 12, h: 8 }]),
    layer("eye_R", [{ x: 58, y: 35, w: 12, h: 8 }]),
    layer("mouth", [{ x: 42, y: 60, w: 16, h: 8 }]),
    layer("nose", [
      { x: 40, y: 40, w: 18, h: 18, alpha: 77 },
      { x: 46, y: 44, w: 8, h: 8 },
    ]),
    layer("iris_L", [{ x: 33, y: 36, w: 6, h: 6 }]),
    layer("iris_R", [{ x: 61, y: 36, w: 6, h: 6 }]),
  ];
}

// The same under bangs painted as two side strands, columns 10..27 and 72..89
// on rows 25..55: the head at the eye row is theirs, 80 px wide.
function strandLayers(): RgbaLayer[] {
  return [
    ...hairlessLayers(),
    layer("hair_front", [
      { x: 10, y: 25, w: 18, h: 31 },
      { x: 72, y: 25, w: 18, h: 31 },
    ]),
  ];
}

function measure(layers: RgbaLayer[]): LayerSetMeasurement {
  const measurer = createLayerSetMeasurer({ width: CANVAS, height: CANVAS });
  for (const l of layers) measurer.add(l);
  return measurer.finish();
}

describe("createLayerSetMeasurer", () => {
  it("measures each layer's crop, the face's row half-widths and the nose's dense core", () => {
    const measurer = createLayerSetMeasurer({ width: CANVAS, height: CANVAS });
    const inputs = strandLayers().map((l) => measurer.add(l));
    const byRole = new Map(inputs.map((l) => [l!.role, l!]));

    // The alpha bbox grown by a pixel; the crop is its size.
    expect(byRole.get("face")).toMatchObject({
      fileName: "face.png",
      canvasW: CANVAS,
      canvasH: CANVAS,
      bbox: { x: 19, y: 19, w: 62, h: 62 },
      cropW: 62,
      cropH: 62,
    });
    // The feather at alpha 77 is inside the crop, under the alpha ≥ 8 rule.
    expect(byRole.get("nose")).toMatchObject({
      bbox: { x: 39, y: 39, w: 20, h: 20 },
      cropW: 20,
      cropH: 20,
    });
    // One entry per crop row: 0 on the grown margin, half of 60 px inside.
    expect(byRole.get("face")!.rowHalfWidths).toEqual([
      0,
      ...Array(60).fill(30),
      0,
    ]);
    // The opaque core, not grown, and the feather left out.
    expect(byRole.get("nose")!.denseCore).toEqual({ x: 46, y: 44, w: 8, h: 8 });
    // Only the face gets row half-widths, only the nose a core.
    for (const l of inputs) {
      if (l!.role !== "face") expect(l!.rowHalfWidths).toBeUndefined();
      if (l!.role !== "nose") expect(l!.denseCore).toBeUndefined();
    }
    expect(measurer.finish().layers).toEqual(inputs);
  });

  it("measures the face's, each hair layer's, the body's and the arms' opaque runs per crop row, gaps and empty rows included", () => {
    const measurer = createLayerSetMeasurer({ width: CANVAS, height: CANVAS });
    const inputs = [
      ...strandLayers(),
      // Row 5 paints 10..13, 20..22 and 95..99 up to the canvas's edge, row
      // 6 10..13, row 7 nothing, row 8 12..16 opaque and 30..31 at alpha 77,
      // which the crop takes in and a run does not.
      layer("hair_back", [
        { x: 10, y: 5, w: 4, h: 2 },
        { x: 20, y: 5, w: 3, h: 1 },
        { x: 95, y: 5, w: 5, h: 1 },
        { x: 12, y: 8, w: 5, h: 1 },
        { x: 30, y: 8, w: 2, h: 1, alpha: 77 },
      ]),
      // A 20-px torso on rows 82..89 over two 6-px legs on rows 90..97, a gap
      // on columns 46..53 between them.
      layer("body", [
        { x: 40, y: 82, w: 20, h: 8 },
        { x: 40, y: 90, w: 6, h: 8 },
        { x: 54, y: 90, w: 6, h: 8 },
      ]),
      layer("arm_L", [{ x: 5, y: 60, w: 6, h: 20 }]),
    ].map((l) => measurer.add(l)!);
    const byRole = new Map(inputs.map((l) => [l.role, l]));

    const back = byRole.get("hair_back")!;
    expect(back.bbox).toEqual({ x: 9, y: 4, w: 91, h: 6 });
    // One entry per crop row, canvas columns, each end exclusive (a run at
    // the canvas's edge ends at its width); the grown margin rows and row 7
    // have no run.
    expect(back.rowRuns).toEqual([
      [],
      [10, 14, 20, 23, 95, 100],
      [10, 14],
      [],
      [12, 17],
      [],
    ]);
    // The bangs' two side strands on rows 25..55, in a crop from row 24.
    expect(byRole.get("hair_front")!.rowRuns).toEqual([
      [],
      ...Array(31).fill([10, 28, 72, 90]),
      [],
    ]);
    // The face plate on rows 20..79, columns 20..79, in a crop from row 19.
    expect(byRole.get("face")!.rowRuns).toEqual([
      [],
      ...Array(60).fill([20, 80]),
      [],
    ]);
    // The torso's rows hold one run, the legs' two, in a crop from row 81.
    expect(byRole.get("body")!.rowRuns).toEqual([
      [],
      ...Array(8).fill([40, 60]),
      ...Array(8).fill([40, 46, 54, 60]),
      [],
    ]);
    // Every arm row one run, in a crop from row 59.
    expect(byRole.get("arm_L")!.rowRuns).toEqual([
      [],
      ...Array(20).fill([5, 11]),
      [],
    ]);
    for (const l of inputs) {
      if (
        ![
          "face",
          "hair_front",
          "hair_back",
          "body",
          "arm_L",
          "arm_R",
          "forearm_pose_L",
          "forearm_pose_R",
        ].includes(l.role)
      ) {
        expect(l.rowRuns).toBeUndefined();
      }
    }
  });

  it("applies the head the bangs draw at the eye row, with every layer's own edges there", () => {
    const result = measure(strandLayers());
    // Columns 10..89 over rows 29..49, against a face-plate half-width of 31.
    expect(result.headHalfWidth).toBe(40);
    expect(result.headHalfWidthApplied).toBe(true);
    expect(result.turnOptions.turnTargets).toEqual({ headHalfWidth: 40 });
    // In add order, model x (canvas x − 50); the mouth has nothing in the
    // band, and the nose's feather is under the opaque rule.
    expect(result.turnOptions.headEdges).toEqual({
      left: [
        { role: "face", x: -30 },
        { role: "eye_L", x: -20 },
        { role: "eye_R", x: 8 },
        { role: "nose", x: -4 },
        { role: "iris_L", x: -17 },
        { role: "iris_R", x: 11 },
        { role: "hair_front", x: -40 },
      ],
      right: [
        { role: "face", x: 29 },
        { role: "eye_L", x: -9 },
        { role: "eye_R", x: 19 },
        { role: "nose", x: 3 },
        { role: "iris_L", x: -12 },
        { role: "iris_R", x: 16 },
        { role: "hair_front", x: 39 },
      ],
    });
  });

  it("leaves a pose forearm, hidden at rest, out of the head's span and edges but records its runs", () => {
    const without = measure(strandLayers());
    // Wider than the bangs across the eye band (rows 29..49).
    const measurer = createLayerSetMeasurer({ width: CANVAS, height: CANVAS });
    const inputs = [
      ...strandLayers(),
      layer("forearm_pose_R", [{ x: 0, y: 30, w: 100, h: 10 }]),
    ].map((l) => measurer.add(l)!);
    const result = measurer.finish();
    expect(result.headHalfWidth).toBe(without.headHalfWidth);
    expect(result.turnOptions.headEdges).toEqual(without.turnOptions.headEdges);
    const pose = inputs.find((l) => l.role === "forearm_pose_R")!;
    expect(pose.rowRuns).toEqual([[], ...Array(10).fill([0, 100]), []]);
  });

  it("measures each iris against the side strand outward of it, as @ikijs/mcp reports it", () => {
    // tools.test.ts' "measures each iris against the side strand outward of
    // it" values: the iris on 33..38 spans −17…−11, the strand on 10..27
    // −40…−22.
    expect(measure(strandLayers()).turnOptions.strandEdges).toEqual({
      left: {
        y: 10.5,
        irisOuter: -17,
        irisInner: -11,
        runOuter: -40,
        runFace: -22,
      },
      right: {
        y: 10.5,
        irisOuter: 17,
        irisInner: 11,
        runOuter: 40,
        runFace: 22,
      },
    });
  });

  it("falls back to the face plate for a hairless set, with nothing in turnOptions", () => {
    const result = measure(hairlessLayers());
    // The widest thing at the eye row is the plate itself, 60 px.
    expect(result.headHalfWidth).toBe(30);
    expect(result.headHalfWidthApplied).toBe(false);
    expect(result.turnOptions).toStrictEqual({});
  });

  it("measures no head for a set painted under ALPHA_OPAQUE, and leaves turnOptions empty", () => {
    // Every painted pixel at alpha 100: over the bbox floor, so each layer
    // still crops, but under the opaque rule, so no union spans the eye row.
    const layers = strandLayers();
    for (const { rgba } of layers) {
      const a = rgba as Uint8ClampedArray;
      for (let i = 3; i < a.length; i += 4) if (a[i] > 0) a[i] = 100;
    }
    const result = measure(layers);
    expect(result.layers).toHaveLength(layers.length);
    expect(result).not.toHaveProperty("headHalfWidth");
    expect(result.headHalfWidthApplied).toBe(false);
    expect(result.turnOptions).toStrictEqual({});
  });

  it("hands the nose no dense core when its opaque pixels are a speck of its crop", () => {
    const measurer = createLayerSetMeasurer({ width: CANVAS, height: CANVAS });
    // A 2×2 opaque dot in an 18×18 feather: under a quarter of the 20 px crop
    // either way, a lone nostril mark rather than the drawing.
    const nose = measurer.add(
      layer("nose", [
        { x: 40, y: 40, w: 18, h: 18, alpha: 77 },
        { x: 48, y: 48, w: 2, h: 2 },
      ]),
    );
    expect(nose).toMatchObject({ bbox: { x: 39, y: 39, w: 20, h: 20 } });
    expect(nose!.denseCore).toBeUndefined();
  });

  // A head on rows 20..59, columns 20..79, and a neck on columns 40..59 below
  // it down to row 89, with a shade band across the neck on rows 61..62 —
  // darker than the skin (luminance 137) but not line work: above DARK_SHARE
  // (0.55) of it.
  const SHADE: [number, number, number] = [150, 90, 45];
  const LINE: [number, number, number] = [40, 20, 10];
  const headAndNeck: Rect[] = [
    { x: 20, y: 20, w: 60, h: 40 },
    { x: 40, y: 60, w: 20, h: 30 },
    { x: 40, y: 61, w: 20, h: 2, rgb: SHADE },
  ];

  it("reads the jaw's stroke under the face's widest row, column by column", () => {
    const measurer = createLayerSetMeasurer({ width: CANVAS, height: CANVAS });
    // The jaw's line across the neck on rows 64..65, and a dark mark on the
    // head above the widest row (an eye's line), which no column scans.
    const face = measurer.add(
      layer("face", [
        ...headAndNeck,
        { x: 40, y: 64, w: 20, h: 2, rgb: LINE },
        { x: 30, y: 30, w: 10, h: 2, rgb: LINE },
      ]),
    )!;
    // One entry per crop column (canvas 19..80): the stroke's last row under
    // the neck, the shade band passed over; −1 where the paint ends first.
    expect(face.jawRows).toEqual(
      Array.from({ length: 62 }, (_, i) =>
        i + 19 >= 40 && i + 19 < 60 ? 65 : -1,
      ),
    );
  });

  it("measures no jaw on a face without line work under its widest row", () => {
    const measurer = createLayerSetMeasurer({ width: CANVAS, height: CANVAS });
    const face = measurer.add(
      layer("face", [...headAndNeck, { x: 30, y: 30, w: 10, h: 2, rgb: LINE }]),
    )!;
    expect(face).not.toHaveProperty("jawRows");
  });

  it("returns null for an empty layer and records nothing for it", () => {
    const measurer = createLayerSetMeasurer({ width: CANVAS, height: CANVAS });
    expect(
      measurer.add({
        role: "hair_back",
        fileName: "hair_back.png",
        rgba: new Uint8ClampedArray(CANVAS * CANVAS * 4),
      }),
    ).toBeNull();
    for (const l of strandLayers()) measurer.add(l);
    expect(measurer.finish()).toEqual(measure(strandLayers()));
  });

  it("keeps nothing of a layer's pixels past its add", () => {
    const measurer = createLayerSetMeasurer({ width: CANVAS, height: CANVAS });
    for (const l of strandLayers()) {
      measurer.add(l);
      (l.rgba as Uint8ClampedArray).fill(0);
    }
    expect(measurer.finish()).toEqual(measure(strandLayers()));
  });

  it("refuses rgba that is not the canvas's size, naming the file", () => {
    const measurer = createLayerSetMeasurer({ width: CANVAS, height: CANVAS });
    expect(() =>
      measurer.add({
        role: "face",
        fileName: "face.png",
        rgba: new Uint8ClampedArray(CANVAS * CANVAS * 4 - 4),
      }),
    ).toThrow(/"face\.png"/);
  });

  it("refuses a canvas side that is not a positive safe integer, naming it", () => {
    for (const field of ["width", "height"] as const) {
      for (const bad of [0, -1, 1.5, NaN, Infinity]) {
        expect(() =>
          createLayerSetMeasurer({ width: 10, height: 10, [field]: bad }),
        ).toThrow(new RegExp(`canvas\\.${field} must be a positive`));
      }
    }
  });

  it("refuses a canvas whose RGBA byte count is not a safe integer, before allocating", () => {
    expect(() =>
      createLayerSetMeasurer({ width: 2 ** 26, height: 2 ** 26 }),
    ).toThrow(/width × height × 4 = \d+ is not a safe integer/);
  });
});
