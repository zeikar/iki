import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { parseIkiModel, type IkiModel } from "@ikijs/format";
import { composeLayersFromParts } from "../src/compose";
import { findBrowser } from "../src/render-browser";
import { planRenders, renderPoses } from "../src/render-poses";
import { autoRigFromLayers } from "../src/tools";
import { writeFullBodyParts } from "./helpers/parts";

const part = (id: string, x: number, y: number) => ({
  id,
  color: [1, 1, 1, 1] as [number, number, number, number],
  width: 10,
  height: 10,
  transform: { x, y },
  order: 0,
});

const model = (
  width: number,
  height: number,
  ids: string[] = [],
  parts = [part("mouth", 0, 0)],
): IkiModel => ({
  version: 1,
  name: "t",
  canvas: { width, height },
  parameters: ids.map((id) => ({ id, min: 0, max: 1, default: 0 })),
  parts,
});

const table = (m: IkiModel) =>
  planRenders(m).poses.map((p) => [p.name, p.values]);

type Row = [string, Record<string, number>];

// The iki-character-loop recipe's poses, in its order, with its values.
const SQUARE: Row[] = [
  ["rest", {}],
  ["turn-m30", { ParamAngleX: -30 }],
  ["turn-p30", { ParamAngleX: 30 }],
  ["turn-15", { ParamAngleX: 15 }],
  ["nod-15", { ParamAngleY: 15 }],
  ["blink", { ParamEyeLOpen: 0 }],
  ["blink-half", { ParamEyeLOpen: 0.5 }],
  ["gaze", { ParamEyeBallX: 1 }],
  ["combined", { ParamAngleX: 30, ParamAngleY: 30, ParamAngleZ: 30 }],
];
const MOUTH: Row[] = [
  ...[0, 0.3, 0.6, 1].flatMap((open): Row[] => [
    [
      `mouth-open-${open}-form-m1`,
      { ParamMouthOpenY: open, ParamMouthForm: -1 },
    ],
    [`mouth-open-${open}-form-0`, { ParamMouthOpenY: open, ParamMouthForm: 0 }],
    [
      `mouth-open-${open}-form-p1`,
      { ParamMouthOpenY: open, ParamMouthForm: 1 },
    ],
  ]),
  ["mouth-laugh", { ParamMouthOpenY: 0.8, ParamMouthForm: 1 }],
  ["mouth-surprised", { ParamMouthOpenY: 0.9 }],
  ["mouth-turn-p30-half", { ParamAngleX: 30, ParamMouthOpenY: 0.5 }],
];
const FULL: Row[] = [
  ["full-rest", {}],
  ["full-turn-p30", { ParamAngleX: 30 }],
  ["full-body-x-m10", { ParamBodyAngleX: -10 }],
  ["full-body-x-p10", { ParamBodyAngleX: 10 }],
  ["full-body-y-m10", { ParamBodyAngleY: -10 }],
  ["full-body-y-p10", { ParamBodyAngleY: 10 }],
  ["full-body-z-m10", { ParamBodyAngleZ: -10 }],
  ["full-body-z-p10", { ParamBodyAngleZ: 10 }],
  ["full-arm-l-16", { ParamArmL: 16 }],
  ["full-arm-l-32", { ParamArmL: 32 }],
  ["full-arm-r-16", { ParamArmR: 16 }],
  ["full-arm-r-32", { ParamArmR: 32 }],
  ["full-elbow-l-m10", { ParamElbowL: -10 }],
  ["full-elbow-l-45", { ParamElbowL: 45 }],
  ["full-elbow-l-90", { ParamElbowL: 90 }],
  ["full-elbow-r-m10", { ParamElbowR: -10 }],
  ["full-elbow-r-45", { ParamElbowR: 45 }],
  ["full-elbow-r-90", { ParamElbowR: 90 }],
];
const POSE: Row[] = [
  ["full-pose-l", { ParamArmPoseL: 1 }],
  ["full-pose-r", { ParamArmPoseR: 1 }],
  ["full-pose-r-angle-m15", { ParamArmPoseR: 1, ParamArmPoseAngleR: -15 }],
  ["full-pose-r-angle-p15", { ParamArmPoseR: 1, ParamArmPoseAngleR: 15 }],
  ["full-pose-r-half", { ParamArmPoseR: 0.5 }],
];

describe("planRenders", () => {
  it("frames a bust on a 560 square with no view and crops only the mouth", () => {
    // s = 0.5 and the mouth at the centre (560, 560).
    const plan = planRenders(model(1120, 1120));
    expect(plan.canvas).toEqual({ width: 560, height: 560 });
    expect(plan.view).toBeUndefined();
    expect(plan.fullBody).toBe(false);
    expect(plan.mouth).toEqual({ cx: 560, cy: 560 });
    expect(table(model(1120, 1120))).toEqual([...SQUARE, ...MOUTH]);
    for (const p of plan.poses) {
      if (p.name.startsWith("mouth-")) {
        expect(p.crop).toEqual({
          sx: 235,
          sy: 250,
          sw: 90,
          sh: 60,
          dw: 720,
          dh: 480,
        });
      } else {
        expect(p.crop).toBeUndefined();
      }
    }
  });

  it("frames a full body in a wide view and crops the middle square", () => {
    const plan = planRenders(
      model(1100, 3692, [], [part("mouth_inner", 0.5, 1238.5)]),
    );
    expect(plan.fullBody).toBe(true);
    expect(plan.canvas).toEqual({ width: 1400, height: 1880 });
    expect(plan.view).toEqual({ x: 0, y: 0, width: 2750, height: 3692 });
    expect(plan.mouth).toEqual({ cx: 550.5, cy: 607.5 });
    expect(plan.poses[0].crop).toEqual({
      sx: 420,
      sy: 0,
      sw: 560,
      sh: 560,
      dw: 560,
      dh: 560,
    });
  });

  it("ceils the full body's canvas height", () => {
    // 560 · 3695 / 1100 = 1881.09: rounding would give 1881.
    expect(planRenders(model(1100, 3695)).canvas.height).toBe(1882);
  });

  it("crops a full body's mouth inside its middle square", () => {
    // s = 0.5, so every crop number is exact.
    const plan = planRenders(
      model(1120, 3695, [], [part("mouth_inner", 0.5, 1238.5)]),
    );
    expect(plan.canvas).toEqual({ width: 1400, height: 1848 });
    expect(plan.poses.find((p) => p.name === "mouth-laugh")?.crop).toEqual({
      sx: 655.25,
      sy: 274.5,
      sw: 90,
      sh: 60,
      dw: 720,
      dh: 480,
    });
    for (const p of plan.poses.filter((p) => p.name.startsWith("full-"))) {
      expect(p.crop).toBeUndefined();
    }
  });

  it("prefers mouth_inner over mouth", () => {
    const m = model(
      1100,
      1100,
      [],
      [part("mouth", 0, 0), part("mouth_inner", 10, 20)],
    );
    expect(planRenders(m).mouth).toEqual({ cx: 560, cy: 530 });
  });

  it("plans no mouth poses without a mouth part", () => {
    const m = model(1100, 1100, [], []);
    expect(planRenders(m).mouth).toBeUndefined();
    expect(table(m)).toEqual(SQUARE);
  });

  it("adds the pose forearm poses last only with ParamArmPoseR", () => {
    const parts = [part("mouth", 0, 0)];
    expect(table(model(1100, 3692, [], parts))).toEqual([
      ...SQUARE,
      ...MOUTH,
      ...FULL,
    ]);
    expect(table(model(1100, 3692, ["ParamArmPoseR"], parts))).toEqual([
      ...SQUARE,
      ...MOUTH,
      ...FULL,
      ...POSE,
    ]);
    expect(table(model(1100, 1100, ["ParamArmPoseR"], parts))).toEqual([
      ...SQUARE,
      ...MOUTH,
    ]);
  });
});

// Temp dirs live UNDER cwd (node_modules is gitignored) so they satisfy the
// output-dir confinement to the working directory.
const createdDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(
    path.join(process.cwd(), "node_modules", ".iki-mcp-render-"),
  );
  createdDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of createdDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("renderPoses refusals", () => {
  it("refuses an outDir outside the working directory", async () => {
    const r = await renderPoses({
      modelPath: "package.json",
      outDir: os.tmpdir(),
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/^output dir escapes the working/);
  });

  it("refuses a missing model", async () => {
    const r = await renderPoses({
      modelPath: "no-such-model.iki",
      outDir: ".",
    });
    expect(!r.ok && r.error).toMatch(/^model file not found: /);
  });

  it("refuses a JSON file that is not a model", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "not.iki"), "{}");
    const r = await renderPoses({
      modelPath: path.join(dir, "not.iki"),
      outDir: dir,
    });
    expect(!r.ok && r.error).toBe("version must be a finite number");
  });
});

// Renders with the BUILT page bundle (dist): run `pnpm build` after an engine edit.
describe.skipIf(findBrowser() === undefined)("renderPoses in a browser", () => {
  const TALL = 3650;

  it("renders a rigged full body into its planned pose PNGs", async () => {
    const parts = fs.mkdtempSync(path.join(os.tmpdir(), "iki-render-parts-"));
    createdDirs.push(parts);
    await writeFullBodyParts(parts);
    const work = tmpDir();
    const composed = await composeLayersFromParts({
      partsDir: parts,
      outDir: work,
      canvasHeight: TALL,
    });
    if (!composed.ok) throw new Error(composed.error);
    const modelPath = path.join(work, "full.iki");
    const rigged = await autoRigFromLayers({
      layers: composed.layers.map((l) => ({ path: l.path })),
      outputPath: modelPath,
    });
    if (!rigged.ok) throw new Error(rigged.error);
    const model = parseIkiModel(JSON.parse(fs.readFileSync(modelPath, "utf8")));
    const plan = planRenders(model);
    const out = tmpDir();

    const r = await renderPoses({ modelPath, outDir: out });
    if (!r.ok) throw new Error(r.error);

    expect(r.poses.map((p) => p.name)).toEqual(plan.poses.map((p) => p.name));
    expect(r.poses.some((p) => p.name.startsWith("full-pose-"))).toBe(false);
    const wholeHeight = Math.ceil((560 * TALL) / 1100);
    for (const p of r.poses) {
      const meta = await sharp(p.path).metadata();
      const want = p.name.startsWith("mouth-")
        ? [720, 480]
        : p.name.startsWith("full-")
          ? [1400, wholeHeight]
          : [560, 560];
      expect([meta.width, meta.height], p.name).toEqual(want);
    }
    const { channels } = await sharp(path.join(out, "rest.png")).stats();
    expect(channels[3].max).toBeGreaterThan(0);

    expect(r.failedTextures).toEqual([]);
    // The engine ignores an unknown parameter id, so a pose that never took
    // would still write a picture: each of these must differ from its rest.
    const png = (name: string) =>
      fs.readFileSync(path.join(out, `${name}.png`));
    for (const [rest, pose] of [
      ["rest", "turn-p30"],
      ["full-rest", "full-arm-l-32"],
    ]) {
      expect(png(pose).equals(png(rest)), `${pose} vs ${rest}`).toBe(false);
    }
  }, 120_000);
});
