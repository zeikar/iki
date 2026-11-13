import { describe, expect, it } from "vitest";
import type { IkiParameter } from "@ikijs/format";
import { parseBakes } from "../src/auto-rig/bakes";
import { BakeError, type CustomPart } from "../src/auto-rig/types";

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
