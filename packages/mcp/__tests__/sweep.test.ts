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
  boxAngles,
  eyeRowModelPx,
  flipbookHtml,
  clearSweepDir,
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
    const spec = sweepSpec(model(1120, 1120), "turn");
    expect(spec.steps).toHaveLength(180);
    expect(spec.parameters).toEqual(["ParamAngleX"]);
    expect(Object.keys(spec.steps[7])).toEqual(["ParamAngleX"]);
    expect(spec.warmup).toBe(30);
    expect(spec.captureEvery).toBe(2);
    expect(spec.frames).toBe(90);
    expect(spec.frameMs).toBe(SWEEP_FRAME_MS);
    expect(spec.kymograph!.band).toBe(KYMOGRAPH_BAND);
    expect(spec.kymograph!.band).toBe(3);
    expect(spec.steps[0].ParamAngleX).toBeCloseTo(0, 12);
    expect(spec.steps[45].ParamAngleX).toBeCloseTo(turnTheta(0.75), 9);
  });

  it("picks nine chronological frames on the -30 to +30 leg, labelled -30 ... +30", () => {
    const spec = sweepSpec(model(1120, 1120), "turn");
    const { frames, labels } = spec.sheet;
    expect(frames).toHaveLength(9);
    expect(labels).toHaveLength(9);
    expect([...frames].sort((a, b) => a - b)).toEqual(frames);
    for (const k of frames) {
      expect(k / 30).toBeGreaterThanOrEqual(0.75);
      expect(k / 30).toBeLessThanOrEqual(2.25);
    }
    const thetas = frames.map((k) => spec.steps[2 * k].ParamAngleX);
    [-30, -20, -10, -5, 0, 5, 10, 20, 30].forEach((target, i) => {
      expect(Math.abs(thetas[i] - target)).toBeLessThan(2.5);
    });
    expect(labels[0]).toMatch(/^θ −30\.\d° {2}t 0\.\d\d s$/);
    expect(labels[8]).toMatch(/^θ \+30\.\d° {2}t 2\.\d\d s$/);
  });

  it("keeps a 560 square at 560 and shrinks a tall face crop to fit 2000 px a side", () => {
    expect(sweepSpec(model(1120, 1120), "turn").sheet.cell).toEqual({
      w: 560,
      h: 560,
    });

    const crop = { sx: 0, sy: 0, sw: 360, sh: 390, dw: 720, dh: 780 };
    const { sheet, frame } = sweepSpec(model(1120, 1120), "turn", crop);
    expect(frame).toEqual({ width: 720, height: 780 });
    const m = SHEET_MARGIN;
    const b = SHEET_LABEL_BAND;
    expect(3 * sheet.cell.w + 2 * m).toBeLessThanOrEqual(2000);
    expect(3 * (sheet.cell.h + b) + 2 * m).toBeLessThanOrEqual(2000);
    // The height is what bounds it, and the aspect is the frame's.
    expect(3 * (sheet.cell.h + b) + 2 * m).toBeGreaterThan(1990);
    expect(sheet.cell.w / sheet.cell.h).toBeCloseTo(720 / 780, 2);
  });

  it("never floors a sheet cell side to 0 for a 1-px-tall crop", () => {
    const crop = { sx: 0, sy: 0, sw: 3000, sh: 1, dw: 3000, dh: 1 };
    const { sheet } = sweepSpec(model(1120, 1120), "turn", crop);
    expect(sheet.cell.w).toBeGreaterThanOrEqual(1);
    expect(sheet.cell.h).toBeGreaterThanOrEqual(1);
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
    expect(sweepSpec(m, "turn").physicsOutputs).toEqual([
      "ParamHairSwayX",
      "ParamLockA",
      "ParamLockB",
    ]);
  });
});

describe("boxAngles", () => {
  it("passes every corner at its time", () => {
    const corners: [number, number, number][] = [
      [0, 0, 0],
      [0.6, 0, -30],
      [1.2, -30, -30],
      [1.8, -30, 0],
      [2.4, -30, 30],
      [3.0, 0, 30],
      [3.6, 30, 30],
      [4.2, 30, 0],
      [4.8, 30, -30],
      [5.4, 0, -30],
      [6, 0, 0],
    ];
    for (const [t, x, y] of corners) {
      const a = boxAngles(t);
      expect(a.x).toBeCloseTo(x, 9);
      expect(a.y).toBeCloseTo(y, 9);
    }
  });

  it("is monotone in each coordinate within every leg", () => {
    const bounds = [0, 0.6, 1.2, 2.4, 3.6, 4.8, 5.4, 6];
    for (let i = 0; i + 1 < bounds.length; i++) {
      const pts = Array.from({ length: 41 }, (_, j) =>
        boxAngles(bounds[i] + ((bounds[i + 1] - bounds[i]) * j) / 40),
      );
      for (const axis of ["x", "y"] as const) {
        const d = pts[40][axis] - pts[0][axis];
        for (let j = 1; j < pts.length; j++) {
          const step = pts[j][axis] - pts[j - 1][axis];
          if (d === 0) expect(step).toBeCloseTo(0, 9);
          else expect(step * d).toBeGreaterThanOrEqual(-1e-9);
        }
      }
    }
  });
});

describe("sweepSpec turn-nod", () => {
  const spec = sweepSpec(model(1120, 1120), "turn-nod");

  it("scripts both angles over 360 steps and 180 frames, with no kymograph", () => {
    expect(spec.steps).toHaveLength(360);
    expect(spec.parameters).toEqual(["ParamAngleX", "ParamAngleY"]);
    expect(spec.frames).toBe(180);
    expect(spec.kymograph).toBeUndefined();
  });

  it("lays the sheet out by angle, a stop on its own frame, rest in the centre", () => {
    expect(spec.sheet.frames).toEqual([72, 90, 108, 54, 0, 126, 36, 18, 144]);
    expect(spec.sheet.labels[0]).toMatch(
      /^X −30\.0° {2}Y \+30\.0° {2}t 2\.40 s$/,
    );
    expect(spec.sheet.labels[4]).toBe("X 0.0°  Y 0.0°  t 0.00 s");
  });

  it("sizes a 720 x 780 crop's cell within 2000 px both sides", () => {
    const crop = { sx: 0, sy: 0, sw: 360, sh: 390, dw: 720, dh: 780 };
    const { sheet } = sweepSpec(model(1120, 1120), "turn-nod", crop);
    expect(3 * sheet.cell.w + 2 * SHEET_MARGIN).toBeLessThanOrEqual(2000);
    expect(
      3 * (sheet.cell.h + SHEET_LABEL_BAND) + 2 * SHEET_MARGIN,
    ).toBeLessThanOrEqual(2000);
  });
});

describe("sweepSpec roll", () => {
  const spec = sweepSpec(model(1120, 1120), "roll");

  it("scripts ParamAngleZ on the turn's own curve: zero at 0 and 1.5 s, -30 and +30 at 0.75 and 2.25 s, every step the turn's angle", () => {
    expect(spec.parameters).toEqual(["ParamAngleZ"]);
    expect(spec.steps).toHaveLength(180);
    expect(Object.keys(spec.steps[7])).toEqual(["ParamAngleZ"]);
    expect(spec.frames).toBe(90);
    for (const j of [0, 90])
      expect(spec.steps[j].ParamAngleZ).toBeCloseTo(0, 9);
    expect(spec.steps[45].ParamAngleZ).toBeCloseTo(-30, 9);
    expect(spec.steps[135].ParamAngleZ).toBeCloseTo(30, 9);
    spec.steps.forEach((s, j) =>
      expect(s.ParamAngleZ).toBeCloseTo(turnTheta(j / 60), 9),
    );
  });

  it("picks nine chronological frames on the -30 to +30 leg, labelled by angle and time, and draws no kymograph", () => {
    const { frames, labels } = spec.sheet;
    expect(frames).toHaveLength(9);
    expect([...frames].sort((a, b) => a - b)).toEqual(frames);
    const thetas = frames.map((k) => spec.steps[2 * k].ParamAngleZ);
    [-30, -20, -10, -5, 0, 5, 10, 20, 30].forEach((target, i) => {
      expect(Math.abs(thetas[i] - target)).toBeLessThan(2.5);
    });
    expect(labels).toHaveLength(9);
    expect(labels[0]).toMatch(/^Z −30\.\d° {2}t 0\.\d\d s$/);
    expect(labels[8]).toMatch(/^Z \+30\.\d° {2}t 2\.\d\d s$/);
    expect(spec.kymograph).toBeUndefined();
  });

  it("frames the sheet as the turn's does", () => {
    expect(spec.sheet.cell).toEqual(
      sweepSpec(model(1120, 1120), "turn").sheet.cell,
    );
  });
});

describe("the kymograph row", () => {
  // 1120 px canvas drawn at 560: s = 0.5, no padding. Eyes at y = +100 are 460 px from the top.
  it("finds the eye row in model px, then in the standard frame", () => {
    expect(eyeRowModelPx(model(1120, 1120))).toBeCloseTo(460, 4);
    expect(
      eyeRowModelPx(model(1120, 1120, [part("eye_L", 0, 0)])),
    ).toBeUndefined();
    const spec = sweepSpec(model(1120, 1120), "turn");
    expect(spec.kymograph).toEqual({ row: 230, band: 3, at: "eye row" });
  });

  it("maps the row through the clamped crop, and falls back to the middle below the eyes", () => {
    const withEyes = sweepSpec(model(1120, 1120), "turn", {
      sx: 0,
      sy: 200,
      sw: 560,
      sh: 280,
      dw: 720,
      dh: 360,
    });
    expect(withEyes.kymograph!.at).toBe("eye row");
    expect(withEyes.kymograph!.row).toBe(Math.round(((230 - 200) * 360) / 280));

    const below = sweepSpec(model(1120, 1120), "turn", {
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
    const spec = sweepSpec(model(1120, 1120, [part("face", 0, 0)]), "turn");
    expect(spec.kymograph).toEqual({ row: 280, band: 3, at: "middle" });
  });
});

const manifest: SweepManifest = {
  version: 2,
  preset: "turn-nod",
  parameters: ["ParamAngleX", "ParamAngleY"],
  fps: 30,
  clockHz: 60,
  warmupS: 0.5,
  durationS: 3,
  crop: null,
  frame: { width: 560, height: 560 },
  kymographRow: null,
  sheet: { frames: [23], cell: { w: 560, h: 560 } },
  physicsOutputs: ["ParamHairSwayX"],
  frames: [
    {
      i: 0,
      file: "f000.png",
      t: 0,
      values: { ParamAngleX: 0, ParamAngleY: 0 },
    },
    {
      i: 1,
      file: "f001.png",
      t: 1 / 30,
      values: { ParamAngleX: -1, ParamAngleY: 0.5 },
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

  it("reads out every scripted id and no theta", () => {
    const html = flipbookHtml(manifest);
    expect(html).toContain('id === "ParamAngleX" ? "X"');
    expect(html).toContain('"ParamAngleY" ? "Y"');
    expect(html).toContain("f.values[id]");
    expect(html).not.toContain("theta");
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
  it("creates the directory and tolerates it existing", () => {
    const out = fs.realpathSync(tmpDir());
    const dir = prepareSweepDir(out, "turn", "sweep");
    expect(dir).toBe(path.join(out, "turn"));
    fs.writeFileSync(path.join(dir, "notes.txt"), "keep");
    expect(prepareSweepDir(out, "turn", "sweep")).toBe(dir);
    expect(fs.readFileSync(path.join(dir, "notes.txt"), "utf8")).toBe("keep");
  });

  it("clears the frames, sheet, kymograph, manifest and flipbook an earlier run left, and only those", () => {
    const out = fs.realpathSync(tmpDir());
    const dir = prepareSweepDir(out, "turn", "sweep");
    const stale = [
      "f123.png",
      "kymograph.png",
      "sheet.png",
      "manifest.json",
      "index.html",
    ];
    for (const f of [...stale, "notes.txt", "f12.png"]) {
      fs.writeFileSync(path.join(dir, f), "x");
    }
    clearSweepDir(prepareSweepDir(out, "turn", "sweep"));
    expect(fs.readdirSync(dir).sort()).toEqual(["f12.png", "notes.txt"]);
  });

  it("refuses a planted symlink and leaves its target alone", () => {
    const out = fs.realpathSync(tmpDir());
    const target = tmpDir(os.tmpdir());
    fs.writeFileSync(path.join(target, "f000.png"), "mine");
    fs.symlinkSync(target, path.join(out, "turn"));
    expect(() => prepareSweepDir(out, "turn", "sweeps[1]")).toThrow(
      /^sweeps\[1\]\.name names .*, a symbolic link/,
    );
    expect(() => prepareSweepDir(out, "turn", "sweep")).toThrow(
      path.join(out, "turn"),
    );
    expect(fs.readFileSync(path.join(target, "f000.png"), "utf8")).toBe("mine");
  });

  it("refuses a file named like the directory", () => {
    const out = fs.realpathSync(tmpDir());
    fs.writeFileSync(path.join(out, "turn"), "x");
    expect(() => prepareSweepDir(out, "turn", "sweep")).toThrow(
      /^sweep\.name names .*, not a directory/,
    );
  });
});
