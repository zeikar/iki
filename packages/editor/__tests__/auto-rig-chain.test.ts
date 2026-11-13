import { describe, expect, it } from "vitest";
import { generateIkiFromLayerSet } from "@ikijs/editor";
import type { IkiDeformer, IkiModel } from "@ikijs/format";
import { matrixWorldAt } from "../src/auto-rig/chain";
import { character } from "./helpers/character";
import { fullBody } from "./helpers/full-body";
import { deformerWorld } from "./helpers/render-oracle";

const FAR = 1000;

/** `character()` with its torso layer dropped: no body warp above the head. */
function bust(): IkiModel {
  const { layers, options } = character();
  return generateIkiFromLayerSet(
    layers.filter((l) => l.role !== "body"),
    { width: 1000, height: 1000 },
    options,
  );
}

/** `character()` as is: its torso layer gives it a body warp. */
function torso(): IkiModel {
  const { layers, options } = character();
  return generateIkiFromLayerSet(
    layers,
    { width: 1000, height: 1000 },
    options,
  );
}

function body(): IkiModel {
  const { layers, options, canvas } = fullBody();
  return generateIkiFromLayerSet(layers, canvas, options);
}

/** Every stop of a parameter's keyforms and the midpoint of each pair, within
 *  the parameter's range, plus its min and max. */
function poses(model: IkiModel, id: string): number[] {
  const p = model.parameters.find((q) => q.id === id)!;
  const stops = new Set<number>([p.min, p.default, p.max]);
  for (const d of model.deformers ?? []) {
    if (d.kind !== "warp") continue;
    for (const w of d.warps ?? []) {
      if (w.parameter === id) for (const k of w.keyforms) stops.add(k.value);
    }
  }
  const sorted = [...stops]
    .filter((v) => v >= p.min && v <= p.max)
    .sort((a, b) => a - b);
  const out = [...sorted];
  for (let i = 0; i + 1 < sorted.length; i++) {
    out.push((sorted[i] + sorted[i + 1]) / 2);
  }
  return out;
}

const PARAMS = [
  "ParamAngleZ",
  "ParamAngleX",
  "ParamBreath",
  "ParamBodyAngleX",
  "ParamBodyAngleY",
  "ParamBodyAngleZ",
];

/** The worst gap to the engine over the poses, and the pose it came at. */
function worstGap(
  model: IkiModel,
  pivot?: { x: number; y: number },
): { gap: number; pose: string } {
  const deformers = model.deformers!.map((d) =>
    pivot !== undefined && d.id === "headDeformer" ? { ...d, pivot } : d,
  );
  const withPivot: IkiModel = { ...model, deformers };
  const head = deformers.find((d) => d.id === "headDeformer") as Extract<
    IkiDeformer,
    { pivot: unknown }
  >;
  const at = (m: readonly number[], x: number, y: number) => [
    m[0] * x + m[2] * y + m[4],
    m[1] * x + m[3] * y + m[5],
  ];
  const probe = [head.pivot.x + FAR, head.pivot.y + FAR];
  let worst = { gap: 0, pose: "rest" };
  const check = (values: Record<string, number>) => {
    const mine = matrixWorldAt(
      deformers,
      model.parameters,
      "headDeformer",
      values,
    );
    const engine = deformerWorld(withPivot, "headDeformer", values);
    const a = at(mine, probe[0], probe[1]);
    const b = at(engine, probe[0], probe[1]);
    const gap = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (gap > worst.gap) worst = { gap, pose: JSON.stringify(values) };
  };
  check({});
  for (const id of PARAMS) {
    if (!model.parameters.some((p) => p.id === id)) continue;
    for (const v of poses(model, id)) check({ [id]: v });
  }
  // A joint pose, so the body's frame and the head's own roll compose.
  check({
    ParamAngleZ: 7,
    ParamAngleX: -12,
    ParamBreath: 0.5,
    ...(model.parameters.some((p) => p.id === "ParamBodyAngleX")
      ? { ParamBodyAngleX: 6, ParamBodyAngleY: -4, ParamBodyAngleZ: 3 }
      : {}),
  });
  return worst;
}

/** `expect` message and value for a parity check. */
function expectParity(model: IkiModel, pivot?: { x: number; y: number }) {
  const { gap, pose } = worstGap(model, pivot);
  expect(gap, `worst pose ${pose}`).toBeLessThan(0.001);
}

describe("matrixWorldAt", () => {
  it("matches the engine on a bust without a body layer", () => {
    const model = bust();
    expect(
      model.deformers!.find((d) => d.id === "headDeformer")!.parent,
    ).toBeUndefined();
    expectParity(model);
  });

  it("matches the engine on a bust with a torso layer, under bodyWarp", () => {
    expectParity(torso());
  });

  it("matches the engine on a full body, under bodyWarp", () => {
    const model = body();
    expect(
      model.deformers!.find((d) => d.id === "headDeformer")!.parent,
    ).toBeDefined();
    expect(model.parameters.some((p) => p.id === "ParamBodyAngleZ")).toBe(true);
    expectParity(model);
  });

  it("poses include every bodyWarp keyform value of the body parameters", () => {
    const model = body();
    const warp = model.deformers!.find((d) => d.id === "bodyWarp") as Extract<
      IkiDeformer,
      { kind: "warp" }
    >;
    for (const id of PARAMS.filter((q) => q.startsWith("ParamBodyAngle"))) {
      const keyed = warp.warps!.find((w) => w.parameter === id);
      expect(keyed, id).toBeDefined();
      const tested = poses(model, id);
      for (const k of keyed!.keyforms) expect(tested, id).toContain(k.value);
    }
  });

  it("matches the engine with the pivot on a grid corner, a row line and a column line", () => {
    const model = body();
    const warp = model.deformers!.find((d) => d.id === "bodyWarp") as Extract<
      IkiDeformer,
      { kind: "warp" }
    >;
    const { cols, rows, points } = warp.grid;
    const stride = cols + 1;
    const pt = (r: number, c: number) => ({
      x: points[(r * stride + c) * 2],
      y: points[(r * stride + c) * 2 + 1],
    });
    const r = Math.floor(rows / 2);
    const c = Math.floor(cols / 2);
    const corner = pt(r, c);
    const rowLine = { x: (pt(r, c).x + pt(r, c + 1).x) / 2, y: pt(r, c).y };
    const colLine = { x: pt(r, c).x, y: (pt(r, c).y + pt(r + 1, c).y) / 2 };
    for (const pivot of [corner, rowLine, colLine]) {
      expectParity(model, pivot);
    }
  });

  it("throws on a parameter the model does not declare", () => {
    const model = bust();
    expect(() =>
      matrixWorldAt(model.deformers!, model.parameters, "headDeformer", {
        ParamNope: 1,
      }),
    ).toThrow(/unknown parameter "ParamNope"/);
  });

  it("throws on a matrix parent, naming it", () => {
    const model = bust();
    const deformers: IkiDeformer[] = [
      { id: "root", pivot: { x: 0, y: 0 } },
      ...model.deformers!.map((d) =>
        d.id === "headDeformer" ? { ...d, parent: "root" } : d,
      ),
    ];
    expect(() =>
      matrixWorldAt(deformers, model.parameters, "headDeformer"),
    ).toThrow(/matrix deformer "root"/);
  });

  it("throws on a warp2d parent and on a warp with a parent", () => {
    const model = body();
    const warp = model.deformers!.find((d) => d.kind === "warp" && !d.parent)!;
    const with2d = model.deformers!.map((d) =>
      d.id === warp.id
        ? {
            ...d,
            warp2d: {
              parameter: "ParamAngleX",
              parameterY: "ParamAngleY",
              valuesX: [0, 1],
              valuesY: [0, 1],
              keyforms2d: [],
            },
          }
        : d,
    ) as IkiDeformer[];
    expect(() =>
      matrixWorldAt(with2d, model.parameters, "headDeformer"),
    ).toThrow(/warp2d/);
    const parented = [
      { id: "root", pivot: { x: 0, y: 0 } },
      ...model.deformers!.map((d) =>
        d.id === warp.id ? { ...d, parent: "root" } : d,
      ),
    ] as IkiDeformer[];
    expect(() =>
      matrixWorldAt(parented, model.parameters, "headDeformer"),
    ).toThrow(/has a parent "root"/);
  });
});
