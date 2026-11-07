/**
 * The sweeps `render_poses` renders on request: an eased ±30 `ParamAngleX`
 * turn, or the `turn-nod` box through every `ParamAngleX` × `ParamAngleY`
 * stop, with the hair physics running. This file is their pure pieces — the
 * schedules, the sheet picks, the kymograph row, the flipbook template and the
 * output directory — all decided in Node; the page only draws what the
 * {@link SweepSpec} says. The page script imports this file for TYPES only (it
 * is bundled as a browser IIFE and must never pull in `node:fs`).
 */

import fs from "node:fs";
import path from "node:path";
import { landParts } from "@ikijs/engine";
import type { IkiModel } from "@ikijs/format";
import { AutoRigInputError, confineToWorkingDirectory } from "./limits";
import { BUST_SIZE, bustPadY, type RenderCrop } from "./render-poses";

/** The physics clock, and the rate the frames are captured at (every second step). */
export const SWEEP_CLOCK_HZ = 60;
export const SWEEP_FPS = 30;
export const SWEEP_DURATION_S = 3;
export const BOX_DURATION_S = 6;
export const SWEEP_PRESETS = ["turn", "turn-nod"] as const;
export type SweepPreset = (typeof SWEEP_PRESETS)[number];
/** Steps at θ = 0 before step 0, so the hair starts settled. A choice of this sweep. */
export const SWEEP_WARMUP_S = 0.5;
/**
 * A hair over one 60 Hz sub-step, the clock `physics-runs.ts` runs
 * `checkPhysics` on: at exactly 1000/60 ms, float rounding leaves the drivers'
 * accumulator just short or just over, so about one frame in three would run no
 * sub-step and about as many two.
 */
export const SWEEP_FRAME_MS = (1000 / SWEEP_CLOCK_HZ) * (1 + 1e-9);
/** The sheet's frames: those nearest each θ, on the −30 → +30 leg. */
export const SHEET_THETAS = [-30, -20, -10, -5, 0, 5, 10, 20, 30];
/** Vision limit when a request carries more than 20 images. */
export const SHEET_MAX_SIDE = 2000;
export const SHEET_MARGIN = 8;
export const SHEET_LABEL_BAND = 24;
/** Rows of the eye row's neighbourhood each frame contributes to the kymograph. */
export const KYMOGRAPH_BAND = 3;

const CAPTURE_EVERY = SWEEP_CLOCK_HZ / SWEEP_FPS;
/** The sheet's leg: 0.75 s is θ = −30, 2.25 s is +30. */
const LEG_FROM_S = 0.75;
const LEG_TO_S = 2.25;
const AMPLITUDE_DEG = 30;
/** The box's corners, in order; each leg runs at BOX_SPEED_DEG_S over its longer axis. */
const BOX_CORNERS: [number, number][] = [
  [0, 0],
  [0, -30],
  [-30, -30],
  [-30, 30],
  [30, 30],
  [30, -30],
  [0, -30],
  [0, 0],
];
const BOX_SPEED_DEG_S = 50;
/** The box sheet's cells, row-major by angle: columns X −30/0/+30, rows Y +30/0/−30. */
const BOX_SHEET_STOPS: [number, number][] = [
  [-30, 30],
  [0, 30],
  [30, 30],
  [-30, 0],
  [0, 0],
  [30, 0],
  [-30, -30],
  [0, -30],
  [30, -30],
];

/** What the caller asks for. */
export interface RequestedSweep {
  /** Becomes the directory `<outDir>/<name>/`. */
  name: string;
  preset: SweepPreset;
  /** Model px from the top-left, as a pose's crop; absent = the standard shot. */
  crop?: { x: number; y: number; w: number; h: number };
}

/** `manifest.json`. */
export interface SweepManifest {
  version: 2;
  preset: SweepPreset;
  parameters: string[];
  fps: number;
  clockHz: number;
  warmupS: number;
  durationS: number;
  crop: { x: number; y: number; w: number; h: number } | null;
  frame: { width: number; height: number };
  kymographRow: { row: number; at: "eye row" | "middle" } | null;
  sheet: { frames: number[]; cell: { w: number; h: number } };
  physicsOutputs: string[];
  frames: {
    i: number;
    file: string;
    t: number;
    /** Every scripted id and every physics output, read off the player after step 2i. */
    values: Record<string, number>;
  }[];
}

/** Everything the page needs, as values: it defines no sweep constant of its own. */
export interface SweepSpec {
  /** The ids `steps` script. */
  parameters: string[];
  frameMs: number;
  /** Clock steps run holding `steps[0]` before step 0. */
  warmup: number;
  /** One record per clock step, the ids in `parameters`. */
  steps: Record<string, number>[];
  /** Frame k shows the pose after clock step `captureEvery · k`. */
  captureEvery: number;
  /** Frames captured. */
  frames: number;
  frame: { width: number; height: number };
  /** The only ids the page lets the motion write. */
  physicsOutputs: string[];
  sheet: {
    /** Frame indices in cell order, row-major. */
    frames: number[];
    cell: { w: number; h: number };
    margin: number;
    labelBand: number;
    labels: string[];
  };
  /** Absent when the preset has none. */
  kymograph?: { row: number; band: number; at: "eye row" | "middle" };
  crop?: RenderCrop;
}

/** The turn: 0 → −30 at 0.75 s → 0 at 1.5 s → +30 at 2.25 s → 0 at 3 s. */
export function turnTheta(t: number): number {
  return -AMPLITUDE_DEG * Math.sin((2 * Math.PI * t) / SWEEP_DURATION_S);
}

/** The box: each leg eased by a half-cosine; a stop is approached and left at rest. */
export function boxAngles(t: number): { x: number; y: number } {
  let start = 0;
  for (let i = 0; i + 1 < BOX_CORNERS.length; i++) {
    const [fx, fy] = BOX_CORNERS[i];
    const [tx, ty] = BOX_CORNERS[i + 1];
    const len = Math.max(Math.abs(tx - fx), Math.abs(ty - fy));
    const dur = len / BOX_SPEED_DEG_S;
    if (t < start + dur) {
      const u = (t - start) / dur;
      const e = (1 - Math.cos(Math.PI * u)) / 2;
      return { x: fx + (tx - fx) * e, y: fy + (ty - fy) * e };
    }
    start += dur;
  }
  return { x: 0, y: 0 };
}

export function sweepDurationS(preset: SweepPreset): number {
  return preset === "turn" ? SWEEP_DURATION_S : BOX_DURATION_S;
}

function schedule(preset: SweepPreset): {
  parameters: string[];
  steps: Record<string, number>[];
  durationS: number;
} {
  const durationS = sweepDurationS(preset);
  const n = SWEEP_CLOCK_HZ * durationS;
  if (preset === "turn") {
    return {
      parameters: ["ParamAngleX"],
      steps: Array.from({ length: n }, (_, j) => ({
        ParamAngleX: turnTheta(j / SWEEP_CLOCK_HZ),
      })),
      durationS,
    };
  }
  return {
    parameters: ["ParamAngleX", "ParamAngleY"],
    steps: Array.from({ length: n }, (_, j) => {
      const { x, y } = boxAngles(j / SWEEP_CLOCK_HZ);
      return { ParamAngleX: x, ParamAngleY: y };
    }),
    durationS,
  };
}

/**
 * The eye row, model px from the top: the mean of the two eye parts' landed
 * bbox centres at rest. Undefined without both.
 */
export function eyeRowModelPx(model: IkiModel): number | undefined {
  const landed = landParts(model, {}, ["eye_L", "eye_R"]);
  const l = landed.get("eye_L");
  const r = landed.get("eye_R");
  if (!l || !r) return undefined;
  const centreY = (pts: Float32Array) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 1; i < pts.length; i += 2) {
      lo = Math.min(lo, pts[i]);
      hi = Math.max(hi, pts[i]);
    }
    return (lo + hi) / 2;
  };
  return model.canvas.height / 2 - (centreY(l) + centreY(r)) / 2;
}

function physicsOutputIds(model: IkiModel): string[] {
  const ids = new Set<string>();
  for (const rig of model.physics ?? []) ids.add(rig.output.parameter);
  for (const chain of model.physicsChains ?? []) {
    for (const seg of chain.segments) ids.add(seg.output.parameter);
  }
  return [...ids];
}

/** Captured frames on the −30 → +30 leg, the one nearest each of SHEET_THETAS, chronological. */
function turnSheetFrames(steps: Record<string, number>[], frames: number) {
  const onLeg: number[] = [];
  for (let k = 0; k < frames; k++) {
    const t = k / SWEEP_FPS;
    if (t >= LEG_FROM_S && t <= LEG_TO_S) onLeg.push(k);
  }
  const x = (k: number) => steps[CAPTURE_EVERY * k].ParamAngleX;
  const picked: number[] = [];
  for (const target of SHEET_THETAS) {
    let best = onLeg[0];
    for (const k of onLeg) {
      // Strict, so a tie keeps the earlier frame.
      if (Math.abs(x(k) - target) < Math.abs(x(best) - target)) best = k;
    }
    if (!picked.includes(best)) picked.push(best);
  }
  return picked.sort((a, b) => a - b);
}

/** One captured frame per box stop, in BOX_SHEET_STOPS order (not sorted). */
function boxSheetFrames(steps: Record<string, number>[], frames: number) {
  return BOX_SHEET_STOPS.map(([sx, sy]) => {
    const miss = (k: number) => {
      const s = steps[CAPTURE_EVERY * k];
      return Math.abs(s.ParamAngleX - sx) + Math.abs(s.ParamAngleY - sy);
    };
    let best = 0;
    for (let k = 1; k < frames; k++) {
      // Strict, so a tie keeps the earlier frame.
      if (miss(k) < miss(best)) best = k;
    }
    return best;
  });
}

function signedDeg(angle: number): string {
  // Rounded first, so a hair under zero never prints as "−0.0".
  const rounded = Math.round(angle * 10) / 10 + 0;
  const deg = rounded.toFixed(1);
  return rounded > 0 ? `+${deg}` : deg.replace("-", "−");
}

/** The schedule and layout the page draws, from the model and the framing. */
export function sweepSpec(
  model: IkiModel,
  preset: SweepPreset,
  crop?: RenderCrop,
): SweepSpec {
  const { parameters, steps, durationS } = schedule(preset);
  const frameCount = durationS * SWEEP_FPS;
  const dw = crop ? crop.dw : BUST_SIZE;
  const dh = crop ? crop.dh : BUST_SIZE;

  const m = SHEET_MARGIN;
  const b = SHEET_LABEL_BAND;
  const scale = Math.min(
    1,
    (SHEET_MAX_SIDE - 2 * m) / (3 * dw),
    (SHEET_MAX_SIDE - 2 * m - 3 * b) / (3 * dh),
  );
  const frames =
    preset === "turn"
      ? turnSheetFrames(steps, frameCount)
      : boxSheetFrames(steps, frameCount);
  const labelOf = (k: number): string => {
    const s = steps[CAPTURE_EVERY * k];
    const t = (k / SWEEP_FPS).toFixed(2);
    return preset === "turn"
      ? `θ ${signedDeg(s.ParamAngleX)}°  t ${t} s`
      : `X ${signedDeg(s.ParamAngleX)}°  Y ${signedDeg(s.ParamAngleY)}°  t ${t} s`;
  };

  const { width: W, height: H } = model.canvas;
  let kymograph: SweepSpec["kymograph"];
  if (preset === "turn") {
    const yModel = eyeRowModelPx(model);
    let row = Math.round(dh / 2);
    let at: "eye row" | "middle" = "middle";
    if (yModel !== undefined) {
      const y0 = bustPadY(W, H);
      const s = BUST_SIZE / W;
      const eyeRow = Math.round(
        crop
          ? ((y0 + yModel * s - crop.sy) * crop.dh) / crop.sh
          : y0 + yModel * s,
      );
      if (eyeRow >= 1 && eyeRow <= dh - 2) {
        row = eyeRow;
        at = "eye row";
      }
    }
    kymograph = { row, band: KYMOGRAPH_BAND, at };
  }

  return {
    parameters,
    frameMs: SWEEP_FRAME_MS,
    warmup: SWEEP_WARMUP_S * SWEEP_CLOCK_HZ,
    steps,
    captureEvery: CAPTURE_EVERY,
    frames: frameCount,
    frame: { width: dw, height: dh },
    physicsOutputs: physicsOutputIds(model),
    sheet: {
      frames,
      cell: {
        w: Math.max(1, Math.floor(dw * scale)),
        h: Math.max(1, Math.floor(dh * scale)),
      },
      margin: m,
      labelBand: b,
      labels: frames.map(labelOf),
    },
    kymograph,
    crop,
  };
}

/**
 * `index.html`: the sweep's frames played from disk. The manifest is inlined
 * (a `file://` page cannot fetch a sibling JSON). `?b=<relative dir>` shows
 * another sweep of the same preset beside it in lockstep, by frame name.
 */
export function flipbookHtml(manifest: SweepManifest): string {
  // `<` escaped so no model-derived id can close the script element.
  const json = JSON.stringify(manifest).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${manifest.preset} sweep</title>
<style>
body { font: 14px system-ui, sans-serif; margin: 16px; background: #222; color: #eee; }
.row { display: flex; gap: 16px; align-items: flex-start; }
img { max-width: 48vw; height: auto; background: #444; }
#b { display: none; }
#controls { margin: 12px 0; display: flex; gap: 12px; align-items: center; }
#scrub { flex: 1; max-width: 640px; }
</style>
</head>
<body>
<div class="row"><img id="a" alt="A"><img id="b" alt="B"></div>
<div id="controls">
<button id="play" type="button">pause</button>
<input id="scrub" type="range" min="0" value="0" step="1">
<span id="readout"></span>
</div>
<p>Add <code>?b=&lt;relative dir&gt;</code> to the address to show another sweep beside this one; it must be a sweep of the same preset, since frames are matched by file name.</p>
<script id="manifest" type="application/json">${json}</script>
<script>
(function () {
  var m = JSON.parse(document.getElementById("manifest").textContent);
  var b = new URLSearchParams(location.search).get("b");
  var a = document.getElementById("a");
  var bi = document.getElementById("b");
  var scrub = document.getElementById("scrub");
  var readout = document.getElementById("readout");
  var play = document.getElementById("play");
  var n = m.frames.length;
  var i = 0;
  var playing = true;
  scrub.max = String(n - 1);
  if (b) { bi.style.display = "block"; }
  function short(id) {
    return id === "ParamAngleX" ? "X" : id === "ParamAngleY" ? "Y" : id;
  }
  function show(k) {
    i = k;
    var f = m.frames[k];
    a.src = f.file;
    if (b) { bi.src = b.replace(/\\/$/, "") + "/" + f.file; }
    scrub.value = String(k);
    readout.textContent = "frame " + k + m.parameters.map(function (id) {
      return "  " + short(id) + " " + f.values[id].toFixed(1) + "\\u00b0";
    }).join("") + "  t " + f.t.toFixed(2) + " s";
  }
  play.addEventListener("click", function () {
    playing = !playing;
    play.textContent = playing ? "pause" : "play";
  });
  scrub.addEventListener("input", function () {
    playing = false;
    play.textContent = "play";
    show(Number(scrub.value));
  });
  setInterval(function () { if (playing) { show((i + 1) % n); } }, 1000 / m.fps);
  show(0);
})();
</script>
</body>
</html>
`;
}

const STALE_FILE = /^f\d{3}\.png$/;
const STALE_NAMES = [
  "kymograph.png",
  "sheet.png",
  "manifest.json",
  "index.html",
];

/**
 * Makes `<outDir>/<name>/` (an existing directory is fine), refuses a symbolic
 * link or a non-directory planted there — it would redirect every frame write
 * — confines it to the working directory, and removes the frames, sheet,
 * kymograph, manifest and flipbook an earlier run left there. `outDir` is the realpath'd dir `resolveOutputDir` returned and `name`
 * is already checked by `planRenders`; `label` names the input in a refusal
 * ("sweep" or `sweeps[i]`). Call only once the browser was found. Returns the
 * real directory; it clears nothing — call `clearSweepDir` once every dir has
 * passed, so a refusal on a later one deletes nothing.
 */
export function prepareSweepDir(
  outDir: string,
  name: string,
  label: string,
): string {
  const dir = path.join(outDir, name);
  try {
    fs.mkdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new AutoRigInputError(`sweep dir: ${(e as Error).message}`);
    }
  }
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink()) {
    throw new AutoRigInputError(`${label}.name names ${dir}, a symbolic link`);
  }
  if (!stat.isDirectory()) {
    throw new AutoRigInputError(`${label}.name names ${dir}, not a directory`);
  }
  return confineToWorkingDirectory(process.cwd(), dir, "sweep dir", name);
}

/** Removes the earlier run's files from a dir `prepareSweepDir` returned. */
export function clearSweepDir(real: string): void {
  // A re-run under the same name must leave nothing of another run for a reader
  // of the whole dir, even when this one throws midway.
  for (const entry of fs.readdirSync(real)) {
    if (STALE_FILE.test(entry) || STALE_NAMES.includes(entry)) {
      fs.rmSync(path.join(real, entry));
    }
  }
}
