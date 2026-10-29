import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IkiModel } from "@ikijs/format";
import {
  KYMOGRAPH_BAND,
  SHEET_LABEL_BAND,
  SHEET_MARGIN,
  SWEEP_FRAME_MS,
  eyeRowModelPx,
  flipbookHtml,
  prepareSweepDir,
  sweepSpec,
  turnTheta,
  type SweepManifest,
} from "../src/sweep";

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
  parts = [part("eye_L", -50, 100), part("eye_R", 50, 100)],
): IkiModel => ({
  version: 1,
  name: "t",
  canvas: { width, height },
  parameters: [],
  parts,
});

describe("turnTheta", () => {
  it("crosses rest at 0, 1.5 and 3 s and peaks at -30 and +30", () => {
    for (const t of [0, 1.5, 3]) expect(turnTheta(t)).toBeCloseTo(0, 9);
    expect(turnTheta(0.75)).toBeCloseTo(-30, 9);
    expect(turnTheta(2.25)).toBeCloseTo(30, 9);
  });

  it("is monotone on each quarter", () => {
    const at = (a: number, b: number) =>
      Array.from({ length: 40 }, (_, i) => turnTheta(a + ((b - a) * i) / 39));
    const down = at(0, 0.75);
    const up = at(0.75, 2.25);
    const back = at(2.25, 3);
    for (let i = 1; i < 40; i++) {
      expect(down[i]).toBeLessThan(down[i - 1]);
      expect(up[i]).toBeGreaterThan(up[i - 1]);
      expect(back[i]).toBeLessThan(back[i - 1]);
    }
  });
});

describe("sweepSpec", () => {
  it("lays out 180 clock steps, a 30-step warm-up and a 3 px kymograph band", () => {
    const spec = sweepSpec(model(1120, 1120));
    expect(spec.thetas).toHaveLength(180);
    expect(spec.warmup).toBe(30);
    expect(spec.captureEvery).toBe(2);
    expect(spec.frames).toBe(90);
    expect(spec.frameMs).toBe(SWEEP_FRAME_MS);
    expect(spec.kymograph.band).toBe(KYMOGRAPH_BAND);
    expect(spec.kymograph.band).toBe(3);
    expect(spec.thetas[0]).toBeCloseTo(0, 12);
    expect(spec.thetas[45]).toBeCloseTo(turnTheta(0.75), 9);
  });

  it("picks nine chronological frames on the -30 to +30 leg, labelled -30 ... +30", () => {
    const spec = sweepSpec(model(1120, 1120));
    const { frames, labels } = spec.sheet;
    expect(frames).toHaveLength(9);
    expect(labels).toHaveLength(9);
    expect([...frames].sort((a, b) => a - b)).toEqual(frames);
    for (const k of frames) {
      expect(k / 30).toBeGreaterThanOrEqual(0.75);
      expect(k / 30).toBeLessThanOrEqual(2.25);
    }
    const thetas = frames.map((k) => spec.thetas[2 * k]);
    [-30, -20, -10, -5, 0, 5, 10, 20, 30].forEach((target, i) => {
      expect(Math.abs(thetas[i] - target)).toBeLessThan(2.5);
    });
    expect(labels[0]).toMatch(/^θ −30\.\d° {2}t 0\.\d\d s$/);
    expect(labels[8]).toMatch(/^θ \+30\.\d° {2}t 2\.\d\d s$/);
  });

  it("keeps a 560 square at 560 and shrinks a tall face crop to fit 2000 px a side", () => {
    expect(sweepSpec(model(1120, 1120)).sheet.cell).toEqual({ w: 560, h: 560 });

    const crop = { sx: 0, sy: 0, sw: 360, sh: 390, dw: 720, dh: 780 };
    const { sheet, frame } = sweepSpec(model(1120, 1120), crop);
    expect(frame).toEqual({ width: 720, height: 780 });
    const m = SHEET_MARGIN;
    const b = SHEET_LABEL_BAND;
    expect(3 * sheet.cell.w + 2 * m).toBeLessThanOrEqual(2000);
    expect(3 * (sheet.cell.h + b) + 2 * m).toBeLessThanOrEqual(2000);
    // The height is what bounds it, and the aspect is the frame's.
    expect(3 * (sheet.cell.h + b) + 2 * m).toBeGreaterThan(1990);
    expect(sheet.cell.w / sheet.cell.h).toBeCloseTo(720 / 780, 2);
  });

  it("lists a spring's output and a chain's segment outputs", () => {
    const m = {
      ...model(1120, 1120),
      physics: [{ id: "p", output: { parameter: "ParamHairSwayX", scale: 1 } }],
      physicsChains: [
        {
          id: "c",
          segments: [
            { output: { parameter: "ParamLockA" } },
            { output: { parameter: "ParamLockB" } },
          ],
        },
      ],
    } as unknown as IkiModel;
    expect(sweepSpec(m).physicsOutputs).toEqual([
      "ParamHairSwayX",
      "ParamLockA",
      "ParamLockB",
    ]);
  });
});

describe("the kymograph row", () => {
  // 1120 px canvas drawn at 560: s = 0.5, no padding. Eyes at y = +100 are 460 px from the top.
  it("finds the eye row in model px, then in the standard frame", () => {
    expect(eyeRowModelPx(model(1120, 1120))).toBeCloseTo(460, 4);
    expect(
      eyeRowModelPx(model(1120, 1120, [part("eye_L", 0, 0)])),
    ).toBeUndefined();
    const spec = sweepSpec(model(1120, 1120));
    expect(spec.kymograph).toEqual({ row: 230, band: 3, at: "eye row" });
  });

  it("maps the row through the clamped crop, and falls back to the middle below the eyes", () => {
    const withEyes = sweepSpec(model(1120, 1120), {
      sx: 0,
      sy: 200,
      sw: 560,
      sh: 280,
      dw: 720,
      dh: 360,
    });
    expect(withEyes.kymograph.at).toBe("eye row");
    expect(withEyes.kymograph.row).toBe(Math.round(((230 - 200) * 360) / 280));

    const below = sweepSpec(model(1120, 1120), {
      sx: 0,
      sy: 300,
      sw: 560,
      sh: 200,
      dw: 720,
      dh: 257,
    });
    expect(below.kymograph).toEqual({
      row: Math.round(257 / 2),
      band: 3,
      at: "middle",
    });
  });

  it("uses the middle row for a model without an eye pair", () => {
    const spec = sweepSpec(model(1120, 1120, [part("face", 0, 0)]));
    expect(spec.kymograph).toEqual({ row: 280, band: 3, at: "middle" });
  });
});

const manifest: SweepManifest = {
  version: 1,
  preset: "turn",
  parameter: "ParamAngleX",
  fps: 30,
  clockHz: 60,
  warmupS: 0.5,
  durationS: 3,
  crop: null,
  frame: { width: 560, height: 560 },
  kymographRow: { row: 230, at: "eye row" },
  sheet: { frames: [23], cell: { w: 560, h: 560 } },
  physicsOutputs: ["ParamHairSwayX"],
  frames: [
    { i: 0, file: "f000.png", t: 0, theta: 0, values: { ParamAngleX: 0 } },
    {
      i: 1,
      file: "f001.png",
      t: 1 / 30,
      theta: -1,
      values: { ParamAngleX: -1 },
    },
  ],
};

describe("flipbookHtml", () => {
  it("inlines the manifest, names every frame and loads nothing external", () => {
    const html = flipbookHtml(manifest);
    expect(html).toContain("f000.png");
    expect(html).toContain("f001.png");
    expect(html).toContain('type="application/json"');
    expect(html).not.toContain("http");
    expect(html).toContain("?b=");
  });

  it("cannot be closed early by an id in the manifest", () => {
    const html = flipbookHtml({
      ...manifest,
      physicsOutputs: ["</script><b>"],
    });
    expect(html).not.toContain("</script><b>");
  });
});

// Under cwd (node_modules is gitignored): prepareSweepDir confines to it.
const created: string[] = [];
function tmpDir(parent = path.join(process.cwd(), "node_modules")): string {
  const d = fs.mkdtempSync(path.join(parent, ".iki-mcp-sweep-"));
  created.push(d);
  return d;
}
afterAll(() => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

describe("prepareSweepDir", () => {
  it("creates the directory, tolerates it existing and drops only stale frames", () => {
    const out = fs.realpathSync(tmpDir());
    const dir = prepareSweepDir(out, "turn");
    expect(dir).toBe(path.join(out, "turn"));
    fs.writeFileSync(path.join(dir, "f123.png"), "x");
    fs.writeFileSync(path.join(dir, "notes.txt"), "keep");
    expect(prepareSweepDir(out, "turn")).toBe(dir);
    expect(fs.existsSync(path.join(dir, "f123.png"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "notes.txt"), "utf8")).toBe("keep");
  });

  it("refuses a planted symlink and leaves its target alone", () => {
    const out = fs.realpathSync(tmpDir());
    const target = tmpDir(os.tmpdir());
    fs.writeFileSync(path.join(target, "f000.png"), "mine");
    fs.symlinkSync(target, path.join(out, "turn"));
    expect(() => prepareSweepDir(out, "turn")).toThrow(/symbolic link/);
    expect(() => prepareSweepDir(out, "turn")).toThrow(path.join(out, "turn"));
    expect(fs.readFileSync(path.join(target, "f000.png"), "utf8")).toBe("mine");
  });

  it("refuses a file named like the directory", () => {
    const out = fs.realpathSync(tmpDir());
    fs.writeFileSync(path.join(out, "turn"), "x");
    expect(() => prepareSweepDir(out, "turn")).toThrow(/not a directory/);
  });
});
