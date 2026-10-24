import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { parseIkiModel, type IkiModel } from "@ikijs/format";
import { composeLayersFromParts } from "../src/compose";
import { checkModelFolds, formatFoldReport } from "../src/fold-report";
import { formatPhysicsReport } from "../src/physics-report";
import { findBrowser } from "../src/render-browser";
import {
  planRenders,
  renderPoses,
  type RenderPosesInput,
} from "../src/render-poses";
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
  [
    "stress",
    {
      ParamAngleX: -30,
      ParamAngleY: -30,
      ParamAngleZ: -30,
      ParamMouthOpenY: 1,
      ParamEyeLOpen: 0.5,
      ParamEyeROpen: 0.5,
      ParamBrowLY: -1,
      ParamBrowRY: 1,
      ParamBrowLAngle: 1,
      ParamBrowRAngle: -1,
    },
  ],
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

  it("leans each body angle the model declares to -10 in stress, and no other", () => {
    const stress = (ids: string[]) =>
      planRenders(model(1100, 1100, ids)).poses.find(
        (p) => p.name === "stress",
      )!.values;
    const head = SQUARE.find(([name]) => name === "stress")![1];

    expect(stress([])).toEqual(head);
    expect(stress(["ParamBodyAngleX"])).toEqual({
      ...head,
      ParamBodyAngleX: -10,
    });
    expect(
      stress(["ParamBodyAngleX", "ParamBodyAngleY", "ParamBodyAngleZ"]),
    ).toEqual({
      ...head,
      ParamBodyAngleX: -10,
      ParamBodyAngleY: -10,
      ParamBodyAngleZ: -10,
    });
    // `combined` never takes them.
    expect(
      planRenders(model(1100, 1100, ["ParamBodyAngleX"])).poses.find(
        (p) => p.name === "combined",
      )!.values,
    ).toEqual({ ParamAngleX: 30, ParamAngleY: 30, ParamAngleZ: 30 });
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

  it("plans only the given poses, uncropped ones framed as the standard shots", () => {
    // The model has a mouth, so its own set would add the mouth crops too.
    const plan = planRenders(model(1120, 1120), [
      { name: "eye-stop", values: { ParamAngleX: -30 } },
      { name: "rest", values: { ParamAngleX: -15 } },
    ]);
    expect(plan.mouth).toBeDefined();
    expect(plan.poses.map((p) => [p.name, p.values])).toEqual([
      ["eye-stop", { ParamAngleX: -30 }],
      ["rest", { ParamAngleX: -15 }],
    ]);
    for (const p of plan.poses) expect(p.crop).toBeUndefined();
  });

  it("converts a crop from model px to canvas px, drawn 720 wide", () => {
    // s = 0.5 on a bust; 720 · 101 / 300 = 242.4 rounds to 242.
    const [pose] = planRenders(model(1120, 1120), [
      { name: "eye", values: {}, crop: { x: 100, y: 200, w: 300, h: 101 } },
    ]).poses;
    expect(pose.crop).toEqual({
      sx: 50,
      sy: 100,
      sw: 150,
      sh: 50.5,
      dw: 720,
      dh: 242,
    });
  });

  it("offsets a crop and the mouth crop by the padding above a landscape model", () => {
    // 800x600: s = 0.7, the model is 420 tall in the 560 square, so 70 px of padding.
    const plan = planRenders(model(800, 600), [
      { name: "c", values: {}, crop: { x: 100, y: 200, w: 200, h: 100 } },
    ]);
    expect(plan.poses[0].crop?.sy).toBeCloseTo(70 + 200 * 0.7);
    const mouth = planRenders(model(800, 600)).poses.find((p) =>
      p.name.startsWith("mouth-"),
    );
    // The mouth part sits at the centre: cy = 300.
    expect(mouth?.crop?.sy).toBeCloseTo(70 + 240 * 0.7);
  });

  it("clamps a crop past the canvas edge to the canvas before converting it", () => {
    // x -50..150 and y 1000..1300 meet the 1120 canvas in 0..150 x 1000..1120.
    const [pose] = planRenders(model(1120, 1120), [
      { name: "edge", values: {}, crop: { x: -50, y: 1000, w: 200, h: 300 } },
    ]).poses;
    expect(pose.crop).toEqual({
      sx: 0,
      sy: 500,
      sw: 75,
      sh: 60,
      dw: 720,
      dh: 576,
    });
  });

  it("frames a full body's uncropped custom pose in the middle square and its crop inside it", () => {
    // s = 0.5 and the square starts at x0 = 420.
    const plan = planRenders(model(1120, 3695), [
      { name: "plain", values: {} },
      {
        name: "cropped",
        values: {},
        crop: { x: 100, y: 2000, w: 200, h: 100 },
      },
    ]);
    expect(plan.poses.map((p) => p.crop)).toEqual([
      { sx: 420, sy: 0, sw: 560, sh: 560, dw: 560, dh: 560 },
      { sx: 470, sy: 1000, sw: 100, sh: 50, dw: 720, dh: 360 },
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

  it("refuses a model outside the working directory", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "iki-render-model-"));
    try {
      const file = path.join(outside, "secret.iki");
      fs.writeFileSync(file, "AKIA1234SECRETKEY=x");
      const r = await renderPoses({ modelPath: file, outDir: "." });
      expect(!r.ok && r.error).toBe(
        `model path escapes the working directory: ${file}`,
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
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

// Each refusal comes back before the browser search, so none needs a browser:
// with one installed a missed refusal would render, without one it would
// report the missing browser instead.
describe("renderPoses refuses a custom pose list", () => {
  const refusal = async (poses: RenderPosesInput["poses"]) => {
    const dir = tmpDir();
    const modelPath = path.join(dir, "m.iki");
    fs.writeFileSync(modelPath, JSON.stringify(model(1100, 1100)));
    const r = await renderPoses({ modelPath, outDir: dir, poses });
    expect(r.ok).toBe(false);
    return !r.ok && r.error;
  };

  it("refuses an empty list", async () => {
    expect(await refusal([])).toBe("poses is empty");
  });

  it.each(["", "../up", "a/b", "a\\b", "has space"])(
    "refuses the name %j, which would not stay a file in outDir",
    async (name) => {
      expect(
        await refusal([
          { name: "ok", values: {} },
          { name, values: {} },
        ]),
      ).toBe(
        `poses[1].name must match ^[A-Za-z0-9_.-]+$ (it names <outDir>/<name>.png): ${JSON.stringify(name)}`,
      );
    },
  );

  it("refuses a repeated name", async () => {
    expect(
      await refusal([
        { name: "a", values: {} },
        { name: "b", values: {} },
        { name: "a", values: { ParamAngleX: 30 } },
      ]),
    ).toBe(
      'poses[2].name "a" repeats poses[0].name "a" (ignoring case: one file on a case-insensitive disk)',
    );
    expect(
      await refusal([
        { name: "rest", values: {} },
        { name: "Rest", values: { ParamAngleX: 30 } },
      ]),
    ).toBe(
      'poses[1].name "Rest" repeats poses[0].name "rest" (ignoring case: one file on a case-insensitive disk)',
    );
  });

  it.each([NaN, Infinity, -Infinity])("refuses the value %s", async (value) => {
    expect(
      await refusal([
        { name: "a", values: { ParamAngleY: 0, ParamAngleX: value } },
      ]),
    ).toBe(`poses[0].values.ParamAngleX must be a finite number, got ${value}`);
  });

  it.each([
    { x: 1100, y: 0, w: 100, h: 100 },
    { x: 0, y: -200, w: 100, h: 200 },
    { x: 10, y: 10, w: 0, h: 100 },
    { x: 10, y: 10, w: 100, h: -5 },
    { x: NaN, y: 10, w: 100, h: 100 },
  ])("refuses the crop %j, which misses the canvas", async (crop) => {
    expect(await refusal([{ name: "a", values: {}, crop }])).toBe(
      "poses[0].crop does not overlap the model's 1100x1100 canvas",
    );
  });

  it("refuses a crop whose clamped shape draws under 1 or over 8192 px tall at 720 wide", async () => {
    // 720 · 0.5 / 1100 = 0.33 rounds to 0.
    expect(
      await refusal([
        { name: "a", values: {}, crop: { x: 0, y: 0, w: 1100, h: 0.5 } },
      ]),
    ).toBe(
      "poses[0].crop meets the canvas in 1100x0.5 model px, which 720 px wide draws 0 px tall, outside 1..8192",
    );
    // 100 wide, but only 10 of it on the canvas: 720 · 1100 / 10 = 79200.
    expect(
      await refusal([
        { name: "a", values: {}, crop: { x: 1090, y: 0, w: 100, h: 1100 } },
      ]),
    ).toBe(
      "poses[0].crop meets the canvas in 10x1100 model px, which 720 px wide draws 79200 px tall, outside 1..8192",
    );
    // The bound itself is drawn: 720 · 1024 / 90 = 8192.
    const [tall] = planRenders(model(1100, 1100), [
      { name: "tall", values: {}, crop: { x: 0, y: 0, w: 90, h: 1024 } },
    ]).poses;
    expect(tall.crop!.dh).toBe(8192);
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
    expect(r.modelCanvas).toEqual({ width: 1100, height: TALL });
    expect(r.folds.poses).toBeGreaterThan(0);
    // The composer requires hair_front, which brings the two sway rigs.
    expect(r.physics.targets).toHaveLength(2);
    for (const t of r.physics.targets) expect(t.kind, t.rig.id).toBe("ok");
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

  it("renders only the given poses, a crop 720 wide, and folds-checks each by its settings, not its name", async () => {
    // A 200 px triangle flat only at ParamAngleX -15, which no default fold
    // pose reaches.
    const m: IkiModel = {
      ...model(1100, 1100, [], []),
      parameters: [{ id: "ParamAngleX", min: -30, max: 30, default: 0 }],
      parts: [
        {
          ...part("face", 0, 0),
          width: 200,
          height: 200,
          mesh: {
            vertices: [-0.5, -0.5, 0.5, -0.5, -0.5, 0.5],
            uvs: [0, 0, 0, 0, 0, 0],
            indices: [0, 1, 2],
          },
          warps: [
            {
              parameter: "ParamAngleX",
              keyforms: [
                { value: -30, offsets: [0, 0, 0, 0, 0, 0] },
                { value: -15, offsets: [0, 0, 0, 0, 0, -1] },
                { value: 0, offsets: [0, 0, 0, 0, 0, 0] },
                { value: 30, offsets: [0, 0, 0, 0, 0, 0] },
              ],
            },
          ],
        },
      ],
    };
    const dir = tmpDir();
    const modelPath = path.join(dir, "fold.iki");
    fs.writeFileSync(modelPath, JSON.stringify(m));

    const r = await renderPoses({
      modelPath,
      outDir: dir,
      poses: [
        {
          name: "rest",
          values: { ParamAngleX: -15 },
          crop: { x: 450, y: 450, w: 200, h: 100 },
        },
        { name: "whole", values: {} },
      ],
    });
    if (!r.ok) throw new Error(r.error);

    expect(r.poses.map((p) => p.name)).toEqual(["rest", "whole"]);
    const size = async (name: string) => {
      const meta = await sharp(path.join(dir, `${name}.png`)).metadata();
      return [meta.width, meta.height];
    };
    expect(await size("rest")).toEqual([720, 360]);
    expect(await size("whole")).toEqual([560, 560]);
    expect(r.folds.poses).toBe(checkModelFolds(m).poses + 2);
    const [line] = formatFoldReport(r.folds, r.modelCanvas);
    expect(line).toMatch(/^FOLD flip part face .* pose \[ParamAngleX=-15\] /);
    // The model's own rigs, which the poses do not add to: it has none.
    expect(formatPhysicsReport(r.physics)).toEqual(["PHYSICS: no rigs"]);
  }, 60_000);
});
