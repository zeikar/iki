/**
 * `auto_rig_from_layers`'s `bakes` on script-drawn layers, a bust and a full
 * body: the `BAKE` lines the engine's landing gives, the refusals, and that a
 * rig without `bakes` is untouched.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { BakeReport, RigBakes } from "@ikijs/editor";
import { loadIkiModel, type IkiModel } from "@ikijs/format";
import { landParts } from "@ikijs/engine";
import { checkBakes } from "../src/bake-report";
import { composeLayersFromParts } from "../src/compose";
import { decodePng } from "../src/node-images";
import {
  autoRigFromLayers,
  type AutoRigCustomPartInput,
  type AutoRigResult,
} from "../src/tools";
import { writeFullBodyParts } from "./helpers/parts";

/** Set by a test to make the generator's echo of what it asked for wrong. */
let doctor = false;
vi.mock("@ikijs/editor", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ikijs/editor")>();
  return {
    ...real,
    generateIkiFromLayerSet: (
      ...[layers, canvas, options]: Parameters<
        typeof real.generateIkiFromLayerSet
      >
    ) =>
      real.generateIkiFromLayerSet(
        layers,
        canvas,
        options?.onBakesApplied === undefined
          ? options
          : {
              ...options,
              onBakesApplied: (reports: BakeReport[]) =>
                options.onBakesApplied!(
                  doctor
                    ? reports.map((r) => ({
                        ...r,
                        wanted: r.wanted.map((w) =>
                          w.map((v, i) => (i === 6 ? v + 0.5 : v)),
                        ),
                      }))
                    : reports,
                ),
            },
      ),
  };
});

type Ok = Extract<AutoRigResult, { ok: true }>;
type Rect = { x: number; y: number; w: number; h: number };

const createdDirs: string[] = [];
/** Output must resolve UNDER cwd; node_modules is gitignored. */
function tmpDir(): string {
  const d = fs.mkdtempSync(
    path.join(process.cwd(), "node_modules", ".iki-mcp-bakes-"),
  );
  createdDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of createdDirs) fs.rmSync(d, { recursive: true, force: true });
});

async function writeLayer(
  dir: string,
  name: string,
  rect: Rect,
  size: { width: number; height: number },
  color = { r: 200, g: 120, b: 60 },
): Promise<string> {
  const filePath = path.join(dir, name);
  const overlay = await sharp({
    create: {
      width: rect.w,
      height: rect.h,
      channels: 4,
      background: { ...color, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  await sharp({
    create: {
      ...size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: overlay, left: rect.x, top: rect.y }])
    .png()
    .toFile(filePath);
  return filePath;
}

/** The bust's role set: the face, eyes, mouth, nose and bangs. */
async function writeBustRoles(dir: string): Promise<{ path: string }[]> {
  const files = [
    ["face.png", { x: 20, y: 20, w: 60, h: 60 }],
    ["eye_L.png", { x: 30, y: 35, w: 12, h: 8 }],
    ["eye_R.png", { x: 58, y: 35, w: 12, h: 8 }],
    ["mouth.png", { x: 42, y: 60, w: 16, h: 8 }],
    ["nose.png", { x: 46, y: 44, w: 8, h: 8 }],
    ["hair_front.png", { x: 10, y: 25, w: 80, h: 31 }],
  ] as const;
  return Promise.all(
    files.map(async ([name, rect]) => ({
      path: await writeLayer(dir, name, rect, { width: 100, height: 100 }),
    })),
  );
}

interface Fixture {
  dir: string;
  layers: { path: string }[];
  tail: AutoRigCustomPartInput;
  /** The tail's rest box, canvas px. */
  box: Rect;
}

/** A tail hanging from the middle of the face, tied inside both boxes. */
async function fixtureOf(
  dir: string,
  layers: { path: string }[],
): Promise<Fixture> {
  const face = await decodePng(
    layers.find((l) => l.path.endsWith("face.png"))!.path,
  );
  const size = { width: face.width, height: face.height };
  const w = Math.round(face.width * 0.2);
  const h = Math.round(face.width * 0.45);
  const box = {
    x: Math.round(face.width * 0.5 - w / 2),
    y: Math.round(face.width * 0.3),
    w,
    h,
  };
  return {
    dir,
    layers,
    box,
    tail: {
      id: "tail",
      path: await writeLayer(dir, "tail.png", box, size, {
        r: 40,
        g: 90,
        b: 200,
      }),
      anchor: "face",
      tie: [box.x + box.w / 2, box.y + 5],
      after: "hair_front",
    },
  };
}

/** A smooth lattice over `box` that is `by` px at the centre. */
function lattice(
  cols: number,
  rows: number,
  by: [number, number],
): [number, number][] {
  const out: [number, number][] = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const k = (r / rows) * 0.7 + (c / cols) * 0.3;
      out.push([by[0] * k, by[1] * (1 - k / 2)]);
    }
  }
  return out;
}

/** Targets on two parameters, the second with two stops and a mirror. */
function bakesFor(box: Rect): RigBakes {
  const s = box.w / 5;
  return {
    targets: [
      {
        id: "turn",
        param: "ParamAngleX",
        parts: ["tail"],
        grid: { cols: 2, rows: 3 },
        stops: {
          "-30": lattice(2, 3, [-1.5 * s, 0.5 * s]),
          "30": lattice(2, 3, [2 * s, -0.5 * s]),
        },
      },
      {
        id: "roll",
        param: "ParamAngleZ",
        parts: ["tail"],
        grid: { cols: 1, rows: 2 },
        stops: { "30": lattice(1, 2, [s, 2 * s]) },
        mirror: true,
      },
    ],
  };
}

async function rig(f: Fixture, name: string, extra: object): Promise<Ok> {
  const r = await autoRigFromLayers({
    layers: f.layers,
    outputPath: path.join(f.dir, name),
    customParts: [f.tail],
    ...extra,
  });
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r;
}

const readModel = (dir: string, name: string): IkiModel =>
  loadIkiModel(fs.readFileSync(path.join(dir, name), "utf8"));

/** The largest `BAKE` error a test read, for the report. */
let largest = 0;

describe.each([
  [
    "a bust",
    async () => {
      const dir = tmpDir();
      return fixtureOf(dir, await writeBustRoles(dir));
    },
  ],
  [
    "a full body",
    async () => {
      const parts = fs.mkdtempSync(path.join(os.tmpdir(), "iki-bakes-parts-"));
      createdDirs.push(parts);
      await writeFullBodyParts(parts);
      const dir = tmpDir();
      const composed = await composeLayersFromParts({
        partsDir: parts,
        outDir: dir,
        canvasHeight: 3650,
        layout: { body: { w: 600, cy: 1585 } },
      });
      if (!composed.ok) throw new Error(composed.error);
      return fixtureOf(
        dir,
        composed.layers.map((l) => ({ path: l.path })),
      );
    },
  ],
])("bakes on %s", (_name, make) => {
  let f: Fixture;
  let bakes: RigBakes;
  let bare: Ok;
  let baked: Ok;

  beforeAll(async () => {
    f = await make();
    bakes = bakesFor(f.box);
    bare = await rig(f, "bare.iki", {});
    baked = await rig(f, "baked.iki", { bakes });
  }, 120_000);

  it("reads one BAKE line per part and parameter, each under 0.1 px", () => {
    const checks = baked.customParts!.bakes!;
    expect(checks.map((b) => [b.part, b.param, b.stops])).toEqual([
      ["tail", "ParamAngleX", [-30, 30]],
      ["tail", "ParamAngleZ", [-30, 30]],
    ]);
    for (const b of checks) {
      expect(b.vertices).toBeGreaterThan(4);
      expect(b.errorPx).toBeLessThan(0.1);
      largest = Math.max(largest, b.errorPx);
    }
  });

  it("moves the tail as the bake asked, through the engine", () => {
    const model = readModel(f.dir, "baked.iki");
    const rest = landParts(model, {}, ["tail"]).get("tail")!;
    const posed = landParts(model, { ParamAngleX: 30 }, ["tail"]).get("tail")!;
    const unbaked = landParts(
      readModel(f.dir, "bare.iki"),
      { ParamAngleX: 30 },
      ["tail"],
    ).get("tail")!;
    // The bake's total (stop) differs from the head's own carry alone.
    let moved = 0;
    for (let i = 0; i < rest.length; i++) {
      moved = Math.max(moved, Math.abs(posed[i] - unbaked[i]));
    }
    expect(moved).toBeGreaterThan(0.5);
  });

  it("adds warps to the custom part and changes nothing else", () => {
    const bareModel = readModel(f.dir, "bare.iki");
    expect(bareModel.parts.find((p) => p.id === "tail")!.warps).toBeUndefined();
    expect(bare.customParts!.bakes).toBeUndefined();

    const model = readModel(f.dir, "baked.iki");
    const stripped: IkiModel = {
      ...model,
      parts: model.parts.map((p) =>
        p.id === "tail" ? { ...p, warps: undefined } : p,
      ),
    };
    expect(JSON.parse(JSON.stringify(stripped))).toEqual(
      JSON.parse(JSON.stringify(bareModel)),
    );
  });
});

describe("refusals write nothing", () => {
  let f: Fixture;
  beforeAll(async () => {
    const dir = tmpDir();
    f = await fixtureOf(dir, await writeBustRoles(dir));
  });

  it("a BakeError is ok: false with its bakes path", async () => {
    const out = path.join(f.dir, "refused.iki");
    const r = await autoRigFromLayers({
      layers: f.layers,
      outputPath: out,
      customParts: [f.tail],
      bakes: {
        targets: [{ ...bakesFor(f.box).targets[0], param: "ParamNope" }],
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(
        /^bakes\.targets\[0\]\.param must be a parameter the model declares/,
      );
    }
    expect(fs.existsSync(out)).toBe(false);
  });

  it("bakes without customParts is refused by name", async () => {
    const out = path.join(f.dir, "no-custom.iki");
    const r = await autoRigFromLayers({
      layers: f.layers,
      outputPath: out,
      bakes: bakesFor(f.box),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^bakes needs customParts/);
    expect(fs.existsSync(out)).toBe(false);
  });

  it("a doctored wanted displacement is a BAKE ERROR and no file", async () => {
    const out = path.join(f.dir, "doctored.iki");
    doctor = true;
    try {
      const r = await autoRigFromLayers({
        layers: f.layers,
        outputPath: out,
        customParts: [f.tail],
        bakes: bakesFor(f.box),
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toMatch(
          /^BAKE ERROR tail ParamAngleX=-30: vertex 3 lands 0\.5\d* px from the displacement the bake asked for/,
        );
      }
      expect(fs.existsSync(out)).toBe(false);
    } finally {
      doctor = false;
    }
  });
});

describe("checkBakes", () => {
  let model: IkiModel;
  beforeAll(async () => {
    const dir = tmpDir();
    const f = await fixtureOf(dir, await writeBustRoles(dir));
    await rig(f, "baked.iki", { bakes: bakesFor(f.box) });
    model = readModel(dir, "baked.iki");
  });

  /** The report asking for exactly what `m` lands at ParamAngleX 30. */
  function landedReport(m: IkiModel): BakeReport {
    const rest = landParts(m, {}, ["tail"]).get("tail")!;
    const posed = landParts(m, { ParamAngleX: 30 }, ["tail"]).get("tail")!;
    const wanted: number[] = [];
    for (let i = 0; i < rest.length; i += 2) {
      wanted.push(posed[i] - rest[i], -(posed[i + 1] - rest[i + 1]));
    }
    return {
      part: "tail",
      param: "ParamAngleX",
      stops: [30],
      vertexCount: rest.length / 2,
      wanted: [wanted],
      ends: [],
    };
  }

  it("passes what the engine lands and refuses a gap over 0.1 px", () => {
    const report = (extra: number): BakeReport => {
      const r = landedReport(model);
      return {
        ...r,
        wanted: [r.wanted[0].map((v, i) => (i === 0 ? v + extra : v))],
      };
    };
    expect(checkBakes(model, [report(0.05)])[0].errorPx).toBeCloseTo(0.05, 3);
    expect(() => checkBakes(model, [report(0.11)])).toThrow(
      /^BAKE ERROR tail ParamAngleX=30: vertex 0 lands 0\.11\d* px.*report this as a bug in the packages$/,
    );
  });

  it("lands a range end through the engine too and refuses a gap there", () => {
    const r = landedReport(model);
    const end = (extra: number): BakeReport => ({
      ...r,
      stops: [],
      wanted: [],
      ends: [
        {
          value: 30,
          wanted: r.wanted[0].map((v, i) => (i === 0 ? v + extra : v)),
        },
      ],
    });
    expect(checkBakes(model, [end(0.05)])[0].errorPx).toBeCloseTo(0.05, 3);
    expect(() => checkBakes(model, [end(0.11)])).toThrow(
      /^BAKE ERROR tail ParamAngleX=30: vertex 0 lands 0\.11\d* px/,
    );
  });

  it("refuses a part the bake moves at rest, though every stop carries the same shift", () => {
    const shifted = structuredClone(model);
    for (const warp of shifted.parts.find((p) => p.id === "tail")!.warps!) {
      for (const kf of warp.keyforms) {
        for (let i = 0; i < kf.offsets.length; i += 2) kf.offsets[i] += 0.05;
      }
    }
    // The report asks for what the shifted model lands, so every stop passes.
    expect(() => checkBakes(shifted, [landedReport(shifted)])).toThrow(
      /^BAKE ERROR tail at rest: the part moved [\d.]+ px, where the bake must leave it.*report this as a bug in the packages$/,
    );
  });
});

afterAll(() => {
  // Read in the run's output: the report quotes it.
  console.log(`largest BAKE error read: ${largest.toFixed(4)} px`);
});
