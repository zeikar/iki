import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { parseIkiModel, type IkiModel } from "@ikijs/format";
import { MAX_PROBE_POINTS, MAX_PROBE_QUERIES } from "../src/limits";
import { paintRuns, probeRig, type ProbeResult } from "../src/probe";

// Temp dirs live UNDER cwd (node_modules is gitignored) so they satisfy the
// working-directory confinement of the model and output paths.
const createdDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(
    path.join(process.cwd(), "node_modules", ".iki-mcp-probe-"),
  );
  createdDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of createdDirs) fs.rmSync(d, { recursive: true, force: true });
});

const QUAD = [-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5];

// A 200 px square centred on the 400 px canvas (canvas 100..300), meshed as a
// quad: ParamAngleX +30 moves it 0.1 of its width (20 px) right, -30 20 px left;
// ParamAngleY +30 moves it 20 px up the canvas (model +y is up, canvas y is down).
// "plain" has no mesh and no warp.
function model(): IkiModel {
  return parseIkiModel({
    version: 1,
    name: "t",
    canvas: { width: 400, height: 400 },
    parameters: [
      { id: "ParamAngleX", min: -30, max: 30, default: 0 },
      { id: "ParamAngleY", min: -30, max: 30, default: 0 },
    ],
    parts: [
      {
        id: "tail",
        color: [1, 1, 1, 1],
        width: 200,
        height: 200,
        transform: { x: 0, y: 0 },
        order: 0,
        mesh: {
          vertices: QUAD,
          uvs: [0, 0, 1, 0, 0, 1, 1, 1],
          indices: [0, 1, 2, 1, 3, 2],
        },
        warps: [
          {
            parameter: "ParamAngleX",
            keyforms: [
              { value: -30, offsets: [-0.1, 0, -0.1, 0, -0.1, 0, -0.1, 0] },
              { value: 0, offsets: [0, 0, 0, 0, 0, 0, 0, 0] },
              { value: 30, offsets: [0.1, 0, 0.1, 0, 0.1, 0, 0.1, 0] },
            ],
          },
          {
            // Model +y is up: +30 raises the part 20 px, i.e. canvas y falls.
            parameter: "ParamAngleY",
            keyforms: [
              { value: -30, offsets: [0, -0.1, 0, -0.1, 0, -0.1, 0, -0.1] },
              { value: 0, offsets: [0, 0, 0, 0, 0, 0, 0, 0] },
              { value: 30, offsets: [0, 0.1, 0, 0.1, 0, 0.1, 0, 0.1] },
            ],
          },
        ],
      },
      {
        id: "plain",
        color: [1, 1, 1, 1],
        width: 100,
        height: 100,
        transform: { x: 0, y: 0 },
        order: 1,
      },
    ],
  });
}

function writeModel(dir: string): string {
  const file = path.join(dir, "m.iki");
  fs.writeFileSync(file, JSON.stringify(model()));
  return file;
}

/** A canvas-sized layer with the given opaque pixels (alpha 255) and any extra alpha. */
async function writeLayer(
  dir: string,
  name: string,
  px: { x: number; y: number; a?: number }[],
  size = 400,
): Promise<string> {
  const rgba = Buffer.alloc(size * size * 4);
  for (const { x, y, a = 255 } of px) rgba[(y * size + x) * 4 + 3] = a;
  const file = path.join(dir, name);
  await sharp(rgba, { raw: { width: size, height: size, channels: 4 } })
    .png()
    .toFile(file);
  return file;
}

const rect = (x0: number, y0: number, w: number, h: number) =>
  Array.from({ length: w * h }, (_, i) => ({
    x: x0 + (i % w),
    y: y0 + Math.floor(i / w),
  }));

function ok(r: ProbeResult) {
  if (!r.ok) throw new Error(r.error);
  if (!("results" in r)) throw new Error("expected inline results");
  return r.results;
}

describe("probeRig land and displacement", () => {
  it("lands a point where the pose puts it, interpolating between keyforms", async () => {
    const dir = tmpDir();
    const modelPath = writeModel(dir);
    const results = ok(
      await probeRig({
        modelPath,
        queries: [
          {
            op: "land",
            part: "tail",
            points: [
              [200, 200],
              [150, 120],
            ],
            pose: { ParamAngleX: 15 },
          },
        ],
      }),
    );
    // Half of the +30 keyform: 10 px right, same row.
    expect(results[0]).toEqual({
      op: "land",
      part: "tail",
      points: [
        [210, 200],
        [160, 120],
      ],
    });
  });

  it("reads the frame as canvas px with y down: an upward model move lowers y", async () => {
    const modelPath = writeModel(tmpDir());
    const [r] = ok(
      await probeRig({
        modelPath,
        queries: [
          {
            op: "land",
            part: "tail",
            points: [[150, 120]],
            pose: { ParamAngleY: 30, ParamAngleX: 30 },
          },
        ],
      }),
    );
    expect(r).toMatchObject({ points: [[170, 100]] });
  });

  it("displacement is land minus rest, and zero at rest", async () => {
    const modelPath = writeModel(tmpDir());
    const results = ok(
      await probeRig({
        modelPath,
        queries: [
          { op: "displacement", part: "tail", points: [[180, 250]] },
          {
            op: "displacement",
            part: "tail",
            points: [[180, 250]],
            pose: { ParamAngleX: -30 },
          },
        ],
      }),
    );
    expect(results[0]).toMatchObject({ points: [[0, 0]] });
    expect(results[1]).toMatchObject({ points: [[-20, 0]] });
  });

  it("a point outside the part's mesh is null, not an extrapolation", async () => {
    const modelPath = writeModel(tmpDir());
    const [r] = ok(
      await probeRig({
        modelPath,
        queries: [
          {
            op: "land",
            part: "tail",
            points: [
              [50, 200],
              [200, 200],
              [301, 200],
            ],
            pose: { ParamAngleX: 30 },
          },
        ],
      }),
    );
    expect(r).toMatchObject({ points: [null, [220, 200], null] });
  });

  it("a part without a mesh lands its unit quad", async () => {
    const modelPath = writeModel(tmpDir());
    const [r] = ok(
      await probeRig({
        modelPath,
        queries: [
          {
            op: "land",
            part: "plain",
            points: [
              [200, 200],
              [160, 160],
              [120, 200],
            ],
          },
        ],
      }),
    );
    expect(r).toMatchObject({
      points: [[200, 200], [160, 160], null],
    });
  });

  it("clamps a value to the parameter's range, as the player does", async () => {
    const modelPath = writeModel(tmpDir());
    const [r] = ok(
      await probeRig({
        modelPath,
        queries: [
          {
            op: "land",
            part: "tail",
            points: [[200, 200]],
            pose: { ParamAngleX: 90 },
          },
        ],
      }),
    );
    expect(r).toMatchObject({ points: [[220, 200]] });
  });
});

describe("probeRig refusals", () => {
  async function refusal(
    queries: unknown,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const r = await probeRig({
      modelPath: writeModel(tmpDir()),
      queries: queries as never,
      ...extra,
    });
    if (r.ok) throw new Error("expected a refusal");
    return r.error;
  }
  const pt = [[200, 200]];

  it("names an undeclared pose id and a non-finite value", async () => {
    expect(
      await refusal([
        { op: "land", part: "tail", points: pt },
        { op: "land", part: "tail", points: pt, pose: { ParamNope: 1 } },
      ]),
    ).toBe("queries[1].pose.ParamNope is not a parameter the model declares");
    expect(
      await refusal([
        {
          op: "land",
          part: "tail",
          points: pt,
          pose: { ParamAngleX: Number.NaN },
        },
      ]),
    ).toBe("queries[0].pose.ParamAngleX must be a finite number");
  });

  it("names an unknown part and an unknown op", async () => {
    expect(await refusal([{ op: "land", part: "ghost", points: pt }])).toMatch(
      /^queries\[0\]\.part names no part of the model: ghost/,
    );
    expect(await refusal([{ op: "spin", part: "tail", points: pt }])).toMatch(
      /^queries\[0\]\.op must be/,
    );
  });

  it("refuses empty, malformed and over-cap points", async () => {
    expect(await refusal([{ op: "land", part: "tail", points: [] }])).toMatch(
      /^queries\[0\]\.points must be a non-empty list/,
    );
    expect(
      await refusal([{ op: "land", part: "tail", points: [[1, Number.NaN]] }]),
    ).toBe("queries[0].points[0] must be [x, y] with finite numbers");
    expect(
      await refusal([{ op: "land", part: "tail", points: [[1, 2, 3]] }]),
    ).toMatch(/^queries\[0\]\.points\[0\] must be \[x, y\]/);
    const many = Array.from({ length: MAX_PROBE_POINTS + 1 }, () => [200, 200]);
    expect(await refusal([{ op: "land", part: "tail", points: many }])).toMatch(
      /^queries\[0\]\.points has 5001 points; at most 5000/,
    );
  });

  it("refuses no queries and too many", async () => {
    expect(await refusal([])).toMatch(/^queries must be a non-empty list/);
    const many = Array.from({ length: MAX_PROBE_QUERIES + 1 }, () => ({
      op: "land",
      part: "tail",
      points: pt,
    }));
    expect(await refusal(many)).toMatch(/^queries has 65 entries; at most 64/);
  });

  it("refuses an outputPath that is not a .probe.json under the working directory", async () => {
    const q = [{ op: "land", part: "tail", points: pt }];
    for (const bad of ["out.txt", "out.json", "package.json"]) {
      expect(await refusal(q, { outputPath: bad })).toMatch(
        /^output path must end in \.probe\.json/,
      );
    }
    expect(await refusal(q, { outputPath: "/tmp/out.probe.json" })).toMatch(
      /^output path escapes the working directory/,
    );
  });

  it("refuses a paint PNG of another size, a missing one and a non-PNG", async () => {
    const dir = tmpDir();
    const small = await writeLayer(dir, "small.png", rect(0, 0, 4, 4), 100);
    expect(await refusal([{ op: "paint", path: small }])).toMatch(
      /^queries\[0\]\.path is 100x100, not the model's canvas 400x400/,
    );
    expect(
      await refusal([{ op: "paint", path: path.join(dir, "none.png") }]),
    ).toMatch(/^queries\[0\]\.path file not found/);
    const text = path.join(dir, "t.png");
    fs.writeFileSync(text, "not a png");
    expect(await refusal([{ op: "paint", path: text }])).toMatch(
      /^queries\[0\]\.path failed to decode PNG/,
    );
  });
});

describe("probeRig paint", () => {
  it("reads the opaque runs per row from the layer PNG, alpha 128 and over", async () => {
    const dir = tmpDir();
    const file = await writeLayer(dir, "tail.png", [
      ...rect(10, 5, 20, 3),
      { x: 100, y: 7 },
      // Row 6 is untouched below; row 9 has only a half-transparent pixel.
      { x: 50, y: 9, a: 127 },
      { x: 60, y: 9, a: 128 },
      { x: 399, y: 11 },
    ]);
    const [r] = ok(
      await probeRig({
        modelPath: writeModel(dir),
        queries: [{ op: "paint", path: file }],
      }),
    );
    expect(r).toEqual({
      op: "paint",
      y0: 5,
      rows: [
        [[10, 30]],
        [[10, 30]],
        [
          [10, 30],
          [100, 101],
        ],
        [],
        [[60, 61]],
        [],
        [[399, 400]],
      ],
    });
  });

  it("a layer with no opaque pixel is { y0: 0, rows: [] }", async () => {
    const dir = tmpDir();
    const file = await writeLayer(dir, "blank.png", [{ x: 5, y: 5, a: 100 }]);
    const [r] = ok(
      await probeRig({
        modelPath: writeModel(dir),
        queries: [{ op: "paint", path: file }],
      }),
    );
    expect(r).toEqual({ op: "paint", y0: 0, rows: [] });
  });

  it("paintRuns reads a decoded layer", () => {
    const rgba = Buffer.alloc(3 * 2 * 4);
    rgba[(1 * 3 + 2) * 4 + 3] = 255;
    expect(paintRuns({ width: 3, height: 2, rgba, hasAlpha: true })).toEqual({
      y0: 1,
      rows: [[[2, 3]]],
    });
  });
});

describe("probeRig outputPath", () => {
  it("writes the JSON the inline result carries, and returns the path and a line per query", async () => {
    const dir = tmpDir();
    const modelPath = writeModel(dir);
    const file = await writeLayer(dir, "tail.png", rect(10, 5, 4, 2));
    const queries = [
      { op: "paint" as const, path: file },
      {
        op: "land" as const,
        part: "tail",
        points: [
          [200, 200],
          [10, 10],
        ] as [number, number][],
        pose: { ParamAngleX: 30 },
      },
    ];
    const inline = ok(await probeRig({ modelPath, queries }));
    const outputPath = path.join(dir, "out.probe.json");
    const r = await probeRig({ modelPath, queries, outputPath });
    if (!r.ok || !("outputPath" in r))
      throw new Error("expected a file result");
    expect(fs.realpathSync(r.outputPath)).toBe(fs.realpathSync(outputPath));
    expect(r.lines).toEqual([
      "0 paint: 2 rows from y 5",
      "1 land tail: 2 points, 1 off the mesh",
    ]);
    expect(JSON.parse(fs.readFileSync(outputPath, "utf8"))).toEqual(inline);
  });
});
