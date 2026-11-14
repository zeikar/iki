import { describe, expect, it, vi } from "vitest";
import type { IkiParameter } from "@ikijs/format";
import { generateIkiFromLayerSet } from "@ikijs/editor";
import type { IkiModel } from "@ikijs/format";
import { parseBakes, rigidResidual } from "../src/auto-rig/bakes";
import { matrixWorldAt } from "../src/auto-rig/chain";
import {
  BakeError,
  type BakeReport,
  type CustomPart,
  type RigBakes,
} from "../src/auto-rig/types";
import { CANVAS, character } from "./helpers/character";
import { fullBody } from "./helpers/full-body";
import { landVertices } from "./helpers/render-oracle";

const part = (id: string, x: number): CustomPart => ({
  id,
  layer: { fileName: `${id}.png`, bbox: { x, y: 100, w: 120, h: 300 } },
  anchor: "face",
  tie: [x + 10, 110],
  after: "hair_back",
});
const parts = [part("tail_L", 50), part("tail_R", 400)];

const parameters: IkiParameter[] = [
  { id: "ParamAngleX", min: -30, max: 30, default: 0 },
  { id: "ParamBrowY", min: 0, max: 1, default: 0.25 },
];

const lattice = (cols: number, rows: number, dx = 1, dy = 2) =>
  Array.from({ length: (cols + 1) * (rows + 1) }, (_, k) => [
    dx * (k + 1),
    dy * (k + 1),
  ]);

const target = (extra: Record<string, unknown> = {}) => ({
  param: "ParamAngleX",
  parts: ["tail_L"],
  grid: { cols: 2, rows: 1 },
  stops: { "30": lattice(2, 1) },
  ...extra,
});

const bakes = (t: unknown = target(), extra: Record<string, unknown> = {}) => ({
  targets: [t],
  ...extra,
});

const refused = (
  input: unknown,
  list: readonly CustomPart[] | null = parts,
): string => {
  try {
    parseBakes(input, list ?? undefined, parameters);
  } catch (e) {
    expect(e).toBeInstanceOf(BakeError);
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
};

describe("parseBakes", () => {
  it("passes a valid input", () => {
    const out = parseBakes(bakes(), parts, parameters);
    expect(out.targets).toHaveLength(1);
    expect(out.targets[0].id).toBe("target0");
    expect(out.targets[0].stops.get(30)).toHaveLength(6);
    expect(out.meshes.size).toBe(0);
  });

  it("refuses bakes without customParts", () => {
    expect(refused(bakes(), null)).toMatch(/^bakes needs customParts/);
    expect(refused(bakes(), [])).toMatch(/^bakes needs customParts/);
  });

  it("refuses a malformed top level", () => {
    expect(refused([])).toMatch(/^bakes must be a plain object/);
    expect(refused({ targets: [], x: 1 })).toMatch(/^bakes\.x is not one of/);
    expect(refused({ targets: [] })).toMatch(
      /^bakes\.targets must be a non-empty array/,
    );
  });

  it("refuses unknown and mistyped target fields", () => {
    expect(refused(bakes(target({ base: "x" })))).toMatch(
      /^bakes\.targets\[0\]\.base is not one of/,
    );
    expect(refused(bakes(5))).toMatch(/^bakes\.targets\[0\] must be a plain/);
    expect(refused(bakes(target({ id: 1 })))).toMatch(
      /^bakes\.targets\[0\]\.id must be a string/,
    );
    expect(refused(bakes(target({ why: 1 })))).toMatch(
      /^bakes\.targets\[0\]\.why must be a string/,
    );
    expect(refused(bakes(target({ mirror: "yes" })))).toMatch(
      /^bakes\.targets\[0\]\.mirror must be true or false/,
    );
  });

  it("refuses a parameter the model does not declare", () => {
    expect(refused(bakes(target({ param: "ParamNope" })))).toMatch(
      /^bakes\.targets\[0\]\.param must be a parameter the model declares/,
    );
    expect(refused(bakes(target({ param: undefined })))).toMatch(
      /^bakes\.targets\[0\]\.param/,
    );
  });

  it("refuses parts that are empty, a role's, unknown or repeated", () => {
    expect(refused(bakes(target({ parts: [] })))).toMatch(
      /^bakes\.targets\[0\]\.parts must be a non-empty array/,
    );
    const m = refused(bakes(target({ parts: ["tail_L", "face"] })));
    expect(m).toMatch(
      /^bakes\.targets\[0\]\.parts\[1\] must be a custom part id/,
    );
    expect(m).toContain("tail_L, tail_R");
    expect(refused(bakes(target({ parts: [3] })))).toMatch(
      /^bakes\.targets\[0\]\.parts\[0\]/,
    );
    expect(refused(bakes(target({ parts: ["tail_L", "tail_L"] })))).toMatch(
      /^bakes\.targets\[0\]\.parts\[1\] repeats/,
    );
  });

  it("refuses a bad grid", () => {
    expect(refused(bakes(target({ grid: 3 })))).toMatch(
      /^bakes\.targets\[0\]\.grid must be/,
    );
    expect(
      refused(bakes(target({ grid: { cols: 2, rows: 1, z: 1 } }))),
    ).toMatch(/^bakes\.targets\[0\]\.grid\.z is not one of/);
    expect(refused(bakes(target({ grid: { cols: 0, rows: 1 } })))).toMatch(
      /^bakes\.targets\[0\]\.grid\.cols 0 is outside \[1, 32\]/,
    );
    expect(refused(bakes(target({ grid: { cols: 2, rows: 33 } })))).toMatch(
      /^bakes\.targets\[0\]\.grid\.rows 33 is outside \[1, 32\]/,
    );
    expect(refused(bakes(target({ grid: { cols: 1.5, rows: 1 } })))).toMatch(
      /^bakes\.targets\[0\]\.grid\.cols/,
    );
  });

  it("refuses a bad box", () => {
    expect(refused(bakes(target({ box: 1 })))).toMatch(
      /^bakes\.targets\[0\]\.box must be/,
    );
    expect(
      refused(bakes(target({ box: { x: 0, y: 0, w: 1, h: 1, z: 1 } }))),
    ).toMatch(/^bakes\.targets\[0\]\.box\.z is not one of/);
    expect(
      refused(bakes(target({ box: { x: 0, y: 0, w: NaN, h: 1 } }))),
    ).toMatch(/^bakes\.targets\[0\]\.box\.w must be a finite number/);
    expect(refused(bakes(target({ box: { x: 0, y: 0, w: 0, h: 1 } })))).toMatch(
      /^bakes\.targets\[0\]\.box\.w 0 is outside \(0, Infinity\]/,
    );
  });

  it("fills a default box from the parts' rest boxes grown by 2 px", () => {
    const one = parseBakes(bakes(), parts, parameters).targets[0];
    expect(one.box).toEqual({ x: 48, y: 98, w: 124, h: 304 });
    const two = parseBakes(
      bakes(target({ parts: ["tail_L", "tail_R"] })),
      parts,
      parameters,
    ).targets[0];
    expect(two.box).toEqual({ x: 48, y: 98, w: 474, h: 304 });
    const given = { x: 1, y: 2, w: 3, h: 4 };
    expect(
      parseBakes(bakes(target({ box: given })), parts, parameters).targets[0]
        .box,
    ).toEqual(given);
  });

  it("refuses bad stops, each at its path", () => {
    expect(refused(bakes(target({ stops: 1 })))).toMatch(
      /^bakes\.targets\[0\]\.stops must be an object/,
    );
    expect(refused(bakes(target({ stops: {} })))).toMatch(
      /^bakes\.targets\[0\]\.stops must have at least one stop/,
    );
    expect(refused(bakes(target({ stops: { far: lattice(2, 1) } })))).toMatch(
      /^bakes\.targets\[0\]\.stops\["far"\] must be keyed by a plain decimal number/,
    );
    expect(refused(bakes(target({ stops: { "31": lattice(2, 1) } })))).toMatch(
      /^bakes\.targets\[0\]\.stops\["31"\] is outside ParamAngleX's range/,
    );
    expect(refused(bakes(target({ stops: { "0": lattice(2, 1) } })))).toMatch(
      /^bakes\.targets\[0\]\.stops\["0"\] is ParamAngleX's rest value/,
    );
    expect(
      refused(
        bakes(
          target({
            param: "ParamBrowY",
            stops: { "0.25": lattice(2, 1) },
          }),
        ),
      ),
    ).toMatch(
      /^bakes\.targets\[0\]\.stops\["0.25"\] is ParamBrowY's rest value/,
    );
    expect(
      refused(
        bakes(
          target({ stops: { "30": lattice(2, 1), "30.0": lattice(2, 1) } }),
        ),
      ),
    ).toMatch(/^bakes\.targets\[0\]\.stops\["30.0"\] repeats/);
    expect(
      refused(bakes(target({ stops: { "30": lattice(2, 1).slice(1) } }))),
    ).toMatch(/^bakes\.targets\[0\]\.stops\["30"\] must be 6 points .* got 5/);
    expect(refused(bakes(target({ stops: { "30": "x" } })))).toMatch(
      /^bakes\.targets\[0\]\.stops\["30"\] must be 6 points/,
    );
  });

  it("refuses a bad point at its index", () => {
    const at = (k: number, v: unknown) => {
      const l = lattice(2, 1) as unknown[];
      l[k] = v;
      return refused(bakes(target({ stops: { "30": l } })));
    };
    expect(at(5, 4)).toMatch(
      /^bakes\.targets\[0\]\.stops\["30"\]\[5\] must be \[dx, dy\]/,
    );
    expect(at(2, [1])).toMatch(
      /^bakes\.targets\[0\]\.stops\["30"\]\[2\] must be \[dx, dy\]/,
    );
    expect(at(4, [1, NaN])).toMatch(
      /^bakes\.targets\[0\]\.stops\["30"\]\[4\]\[1\] must be a finite number/,
    );
    expect(at(0, [Infinity, 1])).toMatch(
      /^bakes\.targets\[0\]\.stops\["30"\]\[0\]\[0\] must be a finite number/,
    );
  });

  it("names the target index in the path", () => {
    const m = refused({ targets: [target(), target({ parts: ["face"] })] });
    expect(m).toMatch(/^bakes\.targets\[1\]\.parts\[0\]/);
    const l = lattice(2, 1) as unknown[];
    l[3] = [0, "a"];
    expect(
      refused({ targets: [target(), target({ stops: { "-30": l } })] }),
    ).toMatch(/^bakes\.targets\[1\]\.stops\["-30"\]\[3\]\[1\]/);
  });

  it("mirrors a missing stop about the rest value", () => {
    const out = parseBakes(bakes(target({ mirror: true })), parts, parameters)
      .targets[0];
    // 3 columns of points per row: column c takes column 2 - c, dx negated.
    const src = out.stops.get(30)!;
    expect(out.stops.get(-30)).toEqual([
      [-src[2][0], src[2][1]],
      [-src[1][0], src[1][1]],
      [-src[0][0], src[0][1]],
      [-src[5][0], src[5][1]],
      [-src[4][0], src[4][1]],
      [-src[3][0], src[3][1]],
    ]);
  });

  it("mirrors about a non-zero rest value and skips what falls outside", () => {
    const out = parseBakes(
      bakes(
        target({
          param: "ParamBrowY",
          mirror: true,
          stops: { "0.5": lattice(2, 1), "1": lattice(2, 1) },
        }),
      ),
      parts,
      parameters,
    ).targets[0];
    // rest 0.25: 0.5 mirrors to 0, 1 to -0.5 (outside 0..1).
    expect([...out.stops.keys()].sort()).toEqual([0, 0.5, 1]);
  });

  it("never overwrites a written stop with a mirrored one", () => {
    const own = lattice(2, 1, 9, 9);
    const out = parseBakes(
      bakes(
        target({
          mirror: true,
          stops: { "30": lattice(2, 1), "-30": own },
        }),
      ),
      parts,
      parameters,
    ).targets[0];
    expect(out.stops.get(-30)).toEqual(own);
  });

  it("treats a mirrored value within float error as the written stop", () => {
    const own = lattice(2, 1, 7, 7);
    const out = parseBakes(
      bakes(
        target({
          param: "ParamHalf",
          mirror: true,
          stops: { "0.7": lattice(2, 1), "0.3": own },
        }),
      ),
      parts,
      [...parameters, { id: "ParamHalf", min: 0, max: 1, default: 0.5 }],
    ).targets[0];
    expect([...out.stops.keys()].sort()).toEqual([0.3, 0.7]);
    expect(out.stops.get(0.3)).toEqual(own);
  });

  it("refuses a key that is not a plain decimal", () => {
    for (const key of ["0x1e", " 30 ", "3e"]) {
      expect(
        refused(bakes(target({ stops: { [key]: lattice(2, 1) } }))),
      ).toMatch(
        /^bakes\.targets\[0\]\.stops\[".*"\] must be keyed by a plain decimal/,
      );
    }
    expect(
      parseBakes(
        bakes(target({ stops: { "3e1": lattice(2, 1) } })),
        parts,
        parameters,
      ).targets[0].stops.has(30),
    ).toBe(true);
  });

  it("accepts the edge of each limit", () => {
    const out = parseBakes(
      bakes(
        target({
          grid: { cols: 32, rows: 32 },
          stops: { "30": lattice(32, 32) },
        }),
      ),
      parts,
      parameters,
    );
    expect(out.targets[0].cols).toBe(32);
  });

  it("does not mirror without mirror", () => {
    const out = parseBakes(bakes(), parts, parameters).targets[0];
    expect([...out.stops.keys()]).toEqual([30]);
  });

  describe("meshes", () => {
    const mesh = (m: unknown) => bakes(target(), { meshes: m });
    // tail_L's box is y 100..400.
    const rows = [100, 200, 400];

    it("passes rows with cols and cellPx", () => {
      const out = parseBakes(
        mesh({
          tail_L: { rows: [100.3, 200, 399.6], cols: 4 },
          tail_R: { cellPx: 12 },
        }),
        parts,
        parameters,
      );
      expect(out.meshes.get("tail_L")).toEqual({
        rows: [100.3, 200, 399.6],
        cols: 4,
      });
      expect(out.meshes.get("tail_R")).toEqual({ cellPx: 12 });
    });

    it("accepts the edge of each mesh limit", () => {
      const ok = (m: unknown) => parseBakes(mesh(m), parts, parameters).meshes;
      expect(ok({ tail_L: { rows, cols: 64 } }).size).toBe(1);
      expect(ok({ tail_L: { cellPx: 4 } }).size).toBe(1);
      expect(ok({ tail_L: { cellPx: 400 } }).size).toBe(1);
      expect(ok({ tail_L: { rows: [99.5, 400.5], cols: 1 } }).size).toBe(1);
    });

    it("refuses a malformed meshes and a part that is not custom", () => {
      expect(refused(mesh([]))).toMatch(/^bakes\.meshes must be an object/);
      expect(refused(mesh({ face: { cellPx: 12 } }))).toMatch(
        /^bakes\.meshes\.face: "face" is not a custom part/,
      );
      expect(refused(mesh({ tail_L: 1 }))).toMatch(
        /^bakes\.meshes\.tail_L must be/,
      );
      expect(refused(mesh({ tail_L: { cellPx: 12, z: 1 } }))).toMatch(
        /^bakes\.meshes\.tail_L\.z is not one of/,
      );
    });

    it("refuses cellPx with rows or out of range", () => {
      expect(refused(mesh({ tail_L: { cellPx: 12, cols: 3 } }))).toMatch(
        /^bakes\.meshes\.tail_L takes/,
      );
      expect(refused(mesh({ tail_L: { cellPx: 3 } }))).toMatch(
        /^bakes\.meshes\.tail_L\.cellPx 3 is outside \[4, 400\]/,
      );
      expect(refused(mesh({ tail_L: { cellPx: 401 } }))).toMatch(
        /^bakes\.meshes\.tail_L\.cellPx/,
      );
    });

    it("refuses a cellPx whose grid passes the format's vertex limit", () => {
      const huge: CustomPart = {
        ...part("slab", 0),
        layer: {
          fileName: "slab.png",
          bbox: { x: 0, y: 0, w: 4000, h: 4000 },
        },
      };
      expect(
        refused(
          {
            targets: [target({ parts: ["slab"] })],
            meshes: { slab: { cellPx: 10 } },
          },
          [huge],
        ),
      ).toMatch(/^bakes\.meshes\.slab\.cellPx 10 makes 160801 vertices/);
    });

    it("refuses bad cols and rows", () => {
      expect(refused(mesh({ tail_L: { rows, cols: 0 } }))).toMatch(
        /^bakes\.meshes\.tail_L\.cols 0 is outside \[1, 64\]/,
      );
      expect(refused(mesh({ tail_L: { rows, cols: 65 } }))).toMatch(
        /^bakes\.meshes\.tail_L\.cols/,
      );
      expect(refused(mesh({ tail_L: { cols: 3 } }))).toMatch(
        /^bakes\.meshes\.tail_L\.rows must be an array of 2 to 400/,
      );
      expect(refused(mesh({ tail_L: { rows: [100], cols: 3 } }))).toMatch(
        /^bakes\.meshes\.tail_L\.rows must be an array/,
      );
      expect(
        refused(mesh({ tail_L: { rows: [100, "a", 400], cols: 3 } })),
      ).toMatch(/^bakes\.meshes\.tail_L\.rows\[1\] must be a finite number/);
      expect(
        refused(mesh({ tail_L: { rows: [100, 300, 300, 400], cols: 3 } })),
      ).toMatch(
        /^bakes\.meshes\.tail_L\.rows\[2\] must be below the row before it/,
      );
    });

    it("holds the first and last row to the box within 0.5 px", () => {
      expect(
        refused(mesh({ tail_L: { rows: [100.6, 400], cols: 3 } })),
      ).toMatch(
        /^bakes\.meshes\.tail_L\.rows\[0\] must be the part's box top 100/,
      );
      expect(
        refused(mesh({ tail_L: { rows: [100, 399.4], cols: 3 } })),
      ).toMatch(
        /^bakes\.meshes\.tail_L\.rows\[1\] must be the part's box bottom 400/,
      );
      expect(
        refused(mesh({ tail_R: { rows: [100, 250, 410], cols: 3 } })),
      ).toMatch(
        /^bakes\.meshes\.tail_R\.rows\[2\] must be the part's box bottom 400/,
      );
    });
  });
});

describe("rigidResidual", () => {
  const pts: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 20],
    [0, 20],
    [4, 7],
  ];
  const turn = (a: number) =>
    pts.map(
      ([x, y]) =>
        [
          5 + Math.cos(a) * x - Math.sin(a) * y,
          -3 + Math.sin(a) * x + Math.cos(a) * y,
        ] as [number, number],
    );

  it("is 0 for a translation and for a rotation about any point", () => {
    expect(rigidResidual(pts, pts)).toBeCloseTo(0, 12);
    expect(rigidResidual(pts, turn(0))).toBeCloseTo(0, 12);
    expect(rigidResidual(pts, turn(1.1))).toBeCloseTo(0, 12);
    expect(rigidResidual([], [])).toBe(0);
  });

  it("is the distance a bent point is left from the best rigid fit", () => {
    const bent = turn(0.3).map(
      ([x, y], i) => (i === 4 ? [x + 2, y] : [x, y]) as [number, number],
    );
    const r = rigidResidual(pts, bent);
    expect(r).toBeGreaterThan(1);
    expect(r).toBeLessThan(2.01);
  });
});

describe("applyBakes", () => {
  const SWAY = "ParamHairSwayX";
  const BOX = { x: 320, y: 220, w: 60, h: 200 };
  const pin = (extra: Partial<CustomPart> = {}): CustomPart => ({
    id: "pin",
    layer: { fileName: "pin.png", bbox: BOX },
    anchor: "face",
    tie: [330, 230],
    after: "hair_back",
    ...extra,
  });
  const bust = character();
  const rigBust = (
    bakes?: RigBakes,
    custom: CustomPart[] = [pin()],
    extra: { onBakesApplied?: (r: BakeReport[]) => void } = {},
  ) =>
    generateIkiFromLayerSet(bust.layers, CANVAS, {
      ...bust.options,
      customParts: custom,
      ...(bakes === undefined ? {} : { bakes }),
      ...extra,
    });

  const control = (
    cols: number,
    rows: number,
    f: (x: number, y: number) => [number, number],
    box = BOX,
  ) => {
    const out: [number, number][] = [];
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        out.push(f(box.x + (box.w * c) / cols, box.y + (box.h * r) / rows));
      }
    }
    return out;
  };
  const same = (dx: number, dy: number) =>
    control(1, 1, () => [dx, dy] as [number, number]);
  const one = (
    param: string,
    v: number,
    lat: [number, number][],
    cols = 1,
  ) => ({
    param,
    parts: ["pin"],
    box: BOX,
    grid: { cols, rows: cols === 1 ? 1 : 2 },
    stops: { [String(v)]: lat },
  });

  /** The canvas-px displacement a part's vertices land with at `params`, from
   *  rest, as the engine renders it. */
  const landed = (
    model: IkiModel,
    id: string,
    params: Record<string, number>,
  ) => {
    const rest = landVertices(model, id);
    const at = landVertices(model, id, params);
    const out: [number, number][] = [];
    for (let i = 0; i < rest.length; i += 2) {
      out.push([at[i] - rest[i], -(at[i + 1] - rest[i + 1])]);
    }
    return out;
  };
  const restCanvas = (model: IkiModel, id: string, w: number, h: number) => {
    const rest = landVertices(model, id);
    const out: [number, number][] = [];
    for (let i = 0; i < rest.length; i += 2) {
      out.push([rest[i] + w / 2, h / 2 - rest[i + 1]]);
    }
    return out;
  };

  it("lands a part where it was asked, through the engine, at every stop", () => {
    // An affine field is exact on a bilinear lattice, so the wanted value at a
    // vertex is the same function of its rest position at any lattice.
    const field = (k: number) => (x: number, y: number) =>
      [
        k * (4 + 0.03 * (x - 350) + 0.02 * (y - 320)),
        k * (-6 + 0.01 * (x - 350) - 0.04 * (y - 320)),
      ] as [number, number];
    let worst = 0;
    const seen = new Set<string>();
    const fb = fullBody({ arms: true });
    for (const [layers, canvas, options] of [
      [bust.layers, CANVAS, bust.options],
      [fb.layers, fb.canvas, fb.options],
    ] as const) {
      const faceBox = layers.find((l) => l.role === "face")!.bbox;
      const part = pin({
        layer: { fileName: "pin.png", bbox: BOX },
        tie: [Math.max(330, faceBox.x + 5), Math.max(230, faceBox.y + 5)],
      });
      const probe = generateIkiFromLayerSet(layers, canvas, {
        ...options,
        customParts: [part],
      });
      for (const param of [
        "ParamAngleX",
        "ParamAngleY",
        "ParamAngleZ",
        "ParamBodyAngleZ",
        SWAY,
      ]) {
        const info = probe.parameters.find((p) => p.id === param);
        if (info === undefined) continue;
        seen.add(param);
        const lo = info.min;
        const hi = info.max;
        const stops = [hi, hi / 2, lo].filter((v) => v !== info.default);
        const targets = [
          {
            param,
            parts: ["pin"],
            box: BOX,
            grid: { cols: 3, rows: 3 },
            stops: Object.fromEntries(
              stops.map((v) => [String(v), control(3, 3, field(v / hi))]),
            ),
          },
        ];
        const model = generateIkiFromLayerSet(layers, canvas, {
          ...options,
          customParts: [part],
          bakes: { targets },
        });
        const rest = restCanvas(model, "pin", canvas.width, canvas.height);
        for (const v of stops) {
          const got = landed(model, "pin", { [param]: v });
          got.forEach(([dx, dy], i) => {
            const [wx, wy] = field(v / hi)(rest[i][0], rest[i][1]);
            worst = Math.max(worst, Math.hypot(dx - wx, dy - wy));
          });
        }
      }
    }
    expect([...seen].sort()).toEqual([
      "ParamAngleX",
      "ParamAngleY",
      "ParamAngleZ",
      "ParamBodyAngleZ",
      SWAY,
    ]);
    expect(worst).toBeLessThan(0.01);
  });

  it("gives zero offsets for the head's own rigid displacement under ParamAngleZ", () => {
    const plain = rigBust();
    const z = 30;
    const w = matrixWorldAt(
      plain.deformers!,
      plain.parameters,
      "headDeformer",
      { ParamAngleZ: z },
    );
    const model = rigBust({
      targets: [
        one(
          "ParamAngleZ",
          z,
          control(2, 2, (x, y) => {
            const mx = x - CANVAS.width / 2;
            const my = CANVAS.height / 2 - y;
            return [
              w[0] * mx + w[2] * my + w[4] - mx,
              -(w[1] * mx + w[3] * my + w[5] - my),
            ];
          }),
          2,
        ),
      ],
    });
    const warp = model.parts
      .find((p) => p.id === "pin")!
      .warps!.find((x) => x.parameter === "ParamAngleZ")!;
    expect(warp.keyforms.map((k) => k.value)).toEqual([0, z]);
    const worst = Math.max(...warp.keyforms[1].offsets.map(Math.abs));
    expect(worst).toBeLessThan(2e-6);
  });

  it("lands the outermost stop's displacement exactly at the stop and at the range end under the head's roll", () => {
    const calls: BakeReport[][] = [];
    const model = rigBust(
      { targets: [one("ParamAngleZ", 15, same(0, 0))] },
      [pin()],
      { onBakesApplied: (r) => calls.push(r) },
    );
    const warp = model.parts
      .find((p) => p.id === "pin")!
      .warps!.find((x) => x.parameter === "ParamAngleZ")!;
    // Rest, the stop and the max; the side below rest has no stop, no keyform.
    expect(warp.keyforms.map((k) => k.value)).toEqual([0, 15, 30]);
    for (const v of [15, 30]) {
      for (const [dx, dy] of landed(model, "pin", { ParamAngleZ: v })) {
        expect(Math.hypot(dx, dy)).toBeLessThan(0.01);
      }
    }
    expect(calls[0][0].stops).toEqual([15]);
    expect(calls[0][0].ends.map((e) => e.value)).toEqual([30]);
    expect(calls[0][0].ends[0].wanted.every((w) => w === 0)).toBe(true);
  });

  it("adds the targets that name a part and parameter", () => {
    const model = rigBust({
      targets: [one(SWAY, 20, same(3, 4)), one(SWAY, 20, same(1, -2))],
    });
    for (const [dx, dy] of landed(model, "pin", { [SWAY]: 20 })) {
      expect(dx).toBeCloseTo(4, 2);
      expect(dy).toBeCloseTo(2, 2);
    }
  });

  it("uses a target's own value where another target has a stop it lacks", () => {
    const model = rigBust({
      targets: [
        one(SWAY, 20, same(4, 0)),
        {
          ...one(SWAY, 10, same(0, 6)),
          stops: { "10": same(0, 6), "20": same(0, 8) },
        },
      ],
    });
    const warp = model.parts.find((p) => p.id === "pin")!.warps![0];
    expect(warp.keyforms.map((k) => k.value)).toEqual([0, 10, 20]);
    const mid = landed(model, "pin", { [SWAY]: 10 })[0];
    // At 10 the first target is half way to its stop: (2, 0), plus (0, 6).
    expect(mid[0]).toBeCloseTo(2, 2);
    expect(mid[1]).toBeCloseTo(6, 2);
  });

  it("writes one warp per parameter, keyforms ascending from the default", () => {
    const model = rigBust({
      targets: [one(SWAY, 20, same(4, 0)), one("ParamAngleX", -30, same(0, 5))],
    });
    const warps = model.parts.find((p) => p.id === "pin")!.warps!;
    expect(warps.map((x) => x.parameter)).toEqual([SWAY, "ParamAngleX"]);
    expect(warps[0].keyforms.map((k) => k.value)).toEqual([0, 20]);
    expect(warps[1].keyforms.map((k) => k.value)).toEqual([-30, 0]);
    const zeros = warps[1].keyforms[1].offsets;
    expect(zeros.every((o) => o === 0)).toBe(true);
  });

  it("moves half as far at half the value, and holds past the stop", () => {
    const model = rigBust({ targets: [one(SWAY, 20, same(4, -2))] });
    const full = landed(model, "pin", { [SWAY]: 20 })[0];
    const half = landed(model, "pin", { [SWAY]: 10 })[0];
    expect(half[0]).toBeCloseTo(full[0] / 2, 3);
    expect(half[1]).toBeCloseTo(full[1] / 2, 3);
    expect(landed(model, "pin", { [SWAY]: 5 })[0][0]).toBeCloseTo(1, 3);
    const info = model.parameters.find((p) => p.id === SWAY)!;
    const edge = landed(model, "pin", { [SWAY]: info.max })[0];
    expect(edge[0]).toBeCloseTo(full[0], 3);
  });

  it("rounds offsets to 1e-6 of the part's size", () => {
    const model = rigBust({ targets: [one(SWAY, 20, same(3.1234567, 0))] });
    const off = model.parts.find((p) => p.id === "pin")!.warps![0].keyforms[1]
      .offsets[0];
    expect(off).toBeCloseTo(3.1234567 / 60, 6);
    expect(Math.abs(off * 1e6 - Math.round(off * 1e6))).toBeLessThan(1e-6);
  });

  it("re-meshes with the same box and UV map, and bakes on the new mesh", () => {
    const base = rigBust();
    const model = rigBust({
      targets: [one(SWAY, 20, same(4, 0))],
      meshes: { pin: { cellPx: 40 } },
    });
    const a = base.parts.find((p) => p.id === "pin")!;
    const b = model.parts.find((p) => p.id === "pin")!;
    expect(b.mesh!.vertices.length).toBeLessThan(a.mesh!.vertices.length);
    // Every new vertex sits where the old picture has that texel.
    for (let i = 0; i < b.mesh!.vertices.length; i++) {
      expect(b.mesh!.uvs[i]).toBeCloseTo(
        i % 2 === 0 ? b.mesh!.vertices[i] + 0.5 : 0.5 - b.mesh!.vertices[i],
        4,
      );
    }
    expect([b.width, b.height, b.transform]).toEqual([
      a.width,
      a.height,
      a.transform,
    ]);
    expect(b.warps![0].keyforms[0].offsets).toHaveLength(
      b.mesh!.vertices.length,
    );
    const rows = rigBust({
      targets: [one(SWAY, 20, same(4, 0))],
      meshes: { pin: { rows: [220, 260, 420], cols: 3 } },
    }).parts.find((p) => p.id === "pin")!;
    expect(rows.mesh!.vertices.length / 2).toBe(4 * 3);
    expect(rows.mesh!.uvs[1 * 2 + 1]).toBeCloseTo(0, 5);
    expect(rows.mesh!.uvs[4 * 2 + 1]).toBeCloseTo(0.2, 5);
  });

  it("leaves a custom part unrigged without bakes", () => {
    const pinPart = rigBust().parts.find((p) => p.id === "pin")!;
    expect(pinPart.warps).toBeUndefined();
  });

  it("reads a non-square lattice with the right stride and cell", () => {
    // 2 columns by 3 rows of nodes, non-affine values; the part's mesh is
    // 3 columns by 10 rows over the same box.
    const node = (r: number, c: number): [number, number] => [
      (r * 3 + c) ** 2 * 0.1,
      c * 5 - r * r,
    ];
    const lat: [number, number][] = [];
    for (let r = 0; r <= 3; r++)
      for (let c = 0; c <= 2; c++) lat.push(node(r, c));
    const calls: BakeReport[][] = [];
    rigBust(
      {
        targets: [
          {
            param: SWAY,
            parts: ["pin"],
            box: BOX,
            grid: { cols: 2, rows: 3 },
            stops: { "20": lat },
          },
        ],
      },
      [pin()],
      { onBakesApplied: (r) => calls.push(r) },
    );
    const w = calls[0][0].wanted[0];
    const at = (col: number, row: number) => {
      const i = row * 4 + col;
      return [w[i * 2], w[i * 2 + 1]];
    };
    const near = (got: number[], want: [number, number]) => {
      expect(got[0]).toBeCloseTo(want[0], 3);
      expect(got[1]).toBeCloseTo(want[1], 3);
    };
    near(at(0, 0), node(0, 0));
    near(at(3, 0), node(0, 2));
    near(at(0, 10), node(3, 0));
    near(at(3, 10), node(3, 2));
    // Vertex (col 1, row 5) rests at canvas (340, 320): u = 2/3 of the way
    // across the first lattice column, v = half way down the second row.
    const fx = 2 / 3;
    const mixed = [0, 1].map((k) => {
      const row = (r: number) =>
        node(r, 0)[k] + (node(r, 1)[k] - node(r, 0)[k]) * fx;
      return row(1) + (row(2) - row(1)) * 0.5;
    }) as [number, number];
    near(at(1, 5), mixed);
  });

  it("keeps each side's target apart when their stops lie either side of rest", () => {
    const model = rigBust({
      targets: [one(SWAY, 20, same(4, 0)), one(SWAY, -20, same(0, 6))],
    });
    const at = (v: number) => landed(model, "pin", { [SWAY]: v })[0];
    for (const [v, want] of [
      [20, [4, 0]],
      [10, [2, 0]],
      [-20, [0, 6]],
      [-10, [0, 3]],
    ] as const) {
      expect(at(v)[0]).toBeCloseTo(want[0], 3);
      expect(at(v)[1]).toBeCloseTo(want[1], 3);
    }
  });

  describe("a rigid part", () => {
    const rigid = [pin({ rigid: true })];
    const bakeOf = (lat: [number, number][]) => ({
      targets: [one(SWAY, 20, lat)],
    });

    it("takes one displacement for every control point", () => {
      expect(() => rigBust(bakeOf(same(7, -3)), rigid)).not.toThrow();
    });

    it("takes a rotation", () => {
      const a = 0.1;
      const lat = control(1, 1, (x, y) => {
        const px = x - 350;
        const py = y - 320;
        return [
          Math.cos(a) * px - Math.sin(a) * py - px,
          Math.sin(a) * px + Math.cos(a) * py - py,
        ];
      });
      expect(() => rigBust(bakeOf(lat), rigid)).not.toThrow();
    });

    it("is refused a shear, naming the target, the stop and the bend", () => {
      const lat = control(1, 1, (_x, y) => [0.2 * (y - 320), 0]);
      let message = "";
      try {
        rigBust(bakeOf(lat), rigid);
      } catch (e) {
        expect(e).toBeInstanceOf(BakeError);
        message = (e as Error).message;
      }
      expect(message).toMatch(
        /^bakes\.targets\[0\] \("target0"\): "pin" is rigid/,
      );
      expect(message).toContain(
        `at ${SWAY} 20 these targets together bend it by`,
      );
      expect(message).toContain(
        "give every control point one displacement, or a rotation",
      );
      // The same lattice on a part that is not rigid bakes.
      expect(() => rigBust(bakeOf(lat))).not.toThrow();
    });
  });

  it("refuses bad bakes before any other check of the rig", () => {
    expect(() =>
      generateIkiFromLayerSet(bust.layers, CANVAS, {
        ...bust.options,
        customParts: [pin()],
        bakes: { targets: [one("ParamNope", 1, same(1, 1))] },
        patches: [{ target: "nowhere" } as never],
      }),
    ).toThrow(BakeError);
  });

  it("reports what each part and parameter was asked, only for a valid model", () => {
    const calls: BakeReport[][] = [];
    rigBust(
      {
        targets: [
          one(SWAY, 20, same(4, 0)),
          one(SWAY, 10, same(0, 6)),
          one("ParamAngleX", -30, same(0, 5)),
        ],
      },
      [pin()],
      { onBakesApplied: (r) => calls.push(r) },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].map((r) => [r.part, r.param, r.stops])).toEqual([
      ["pin", SWAY, [10, 20]],
      ["pin", "ParamAngleX", [-30]],
    ]);
    const first = calls[0][0];
    expect(first.vertexCount).toBe(first.wanted[0].length / 2);
    expect(first.wanted).toHaveLength(2);
    // At 10: the second target's (0, 6) and half the first's (4, 0).
    expect(first.wanted[0].slice(0, 2)).toEqual([2, 6]);
    expect(first.wanted[1].slice(0, 2)).toEqual([4, 6]);

    const refused = vi.fn();
    expect(() =>
      rigBust({ targets: [one("ParamNope", 1, same(1, 1))] }, [pin()], {
        onBakesApplied: refused,
      }),
    ).toThrow(BakeError);
    expect(refused).not.toHaveBeenCalled();
  });

  it("refuses bakes without custom parts", () => {
    expect(() => rigBust({ targets: [one(SWAY, 20, same(1, 1))] }, [])).toThrow(
      /^bakes needs customParts/,
    );
  });
});
