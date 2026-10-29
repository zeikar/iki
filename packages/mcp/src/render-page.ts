/**
 * The page script behind `render_poses`: the real engine plus a small
 * load/capture API on `window`. tsup bundles it into a self-contained IIFE
 * (`dist/render-page.global.js`) that Node evaluates into a blank page, so a
 * pose is rendered by the same code a host runs. Browser-only; never imported
 * by the Node bundles.
 */

import { IkiMotion, IkiPlayer } from "@ikijs/engine";
import type { IkiModel } from "@ikijs/format";
// Type-only: erased, so nothing from the planner enters the bundle, but the
// page and the planner cannot drift apart.
import type { RenderCrop, RenderPlan } from "./render-poses";
import type { SweepSpec } from "./sweep";

interface IkiRenderApi {
  load(
    model: IkiModel,
    options: Pick<RenderPlan, "canvas" | "view">,
  ): Promise<{ failedTextures: number[] }>;
  capture(values: Record<string, number>, crop?: RenderCrop): Promise<string>;
  sweepBegin(spec: SweepSpec): Promise<void>;
  sweepFrame(): Promise<{ png: string; values: Record<string, number> }>;
  sweepEnd(): Promise<{ sheet: string; kymograph: string }>;
}

declare global {
  interface Window {
    __ikiRender: IkiRenderApi;
  }
}

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

// Two frames, as the playground recipe waits: the player draws on its own rAF
// loop, so by then the canvas holds the new state.
const settle = async (): Promise<void> => {
  await nextFrame();
  await nextFrame();
};

let player: IkiPlayer | undefined;
let canvas: HTMLCanvasElement | undefined;
let loaded: IkiModel | undefined;

interface Sweep {
  spec: SweepSpec;
  motion: IkiMotion;
  cells: Map<number, HTMLCanvasElement>;
  kymograph: HTMLCanvasElement;
  /** The next clock step to run. */
  nextStep: number;
  frame: number;
}
let sweep: Sweep | undefined;

const resetParameters = (p: IkiPlayer): void => {
  for (const { id, default: d } of p.getParameters()) p.setParameter(id, d);
};

// The canvas as a pose is shot: the whole of it, or the crop drawn out.
const frameCanvas = (c: HTMLCanvasElement, crop?: RenderCrop) => {
  if (!crop) return c;
  const out = document.createElement("canvas");
  out.width = crop.dw;
  out.height = crop.dh;
  out
    .getContext("2d")!
    .drawImage(c, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.dw, crop.dh);
  return out;
};

const newCanvas = (width: number, height: number): HTMLCanvasElement => {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
};

window.__ikiRender = {
  async load(model, { canvas: size, view }) {
    canvas = document.createElement("canvas");
    // Sized through style so the backing store follows at dpr 1; a mismatch
    // below means the browser disagreed.
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    document.body.appendChild(canvas);
    player = new IkiPlayer(canvas);
    player.start();
    loaded = model;
    const { failedTextures } = await player.load(model);
    if (view) player.setView(view);
    await settle();
    if (canvas.width !== size.width || canvas.height !== size.height) {
      throw new Error(
        `canvas is ${canvas.width}x${canvas.height}, expected ${size.width}x${size.height} (device pixel ratio?)`,
      );
    }
    return { failedTextures };
  },

  async capture(values, crop) {
    if (!player || !canvas) throw new Error("capture() called before load()");
    // Every pose starts from the defaults so one pose never leaks into the next.
    for (const p of player.getParameters()) {
      player.setParameter(p.id, p.default);
    }
    for (const [id, value] of Object.entries(values)) {
      player.setParameter(id, value);
    }
    await settle();
    return frameCanvas(canvas, crop).toDataURL("image/png");
  },

  async sweepBegin(spec) {
    if (!player || !canvas || !loaded) {
      throw new Error("sweepBegin() called before load()");
    }
    const p = player;
    resetParameters(p);
    // The idle, clips and expressions flush through the one sink; only the
    // physics outputs get through, so the hair moves and nothing else does.
    const outputs = new Set(spec.physicsOutputs);
    const motion = new IkiMotion(
      loaded,
      (id) => p.getParameter(id),
      (id, value) => {
        if (outputs.has(id)) p.setParameter(id, value);
      },
    );
    for (let step = 0; step < spec.warmup; step++) {
      p.setParameter(spec.parameter, spec.thetas[0]);
      motion.update(step * spec.frameMs);
    }
    const cells = new Map<number, HTMLCanvasElement>();
    for (const k of spec.sheet.frames) {
      cells.set(k, newCanvas(spec.sheet.cell.w, spec.sheet.cell.h));
    }
    sweep = {
      spec,
      motion,
      cells,
      kymograph: newCanvas(spec.frame.width, spec.frames * spec.kymograph.band),
      nextStep: 0,
      frame: 0,
    };
  },

  async sweepFrame() {
    if (!player || !canvas || !sweep) {
      throw new Error("sweepFrame() called before sweepBegin()");
    }
    const { spec, motion, cells, kymograph } = sweep;
    // Frame k shows the pose after clock step captureEvery · k: one step on
    // the first call, captureEvery on every later one.
    while (sweep.nextStep <= spec.captureEvery * sweep.frame) {
      player.setParameter(spec.parameter, spec.thetas[sweep.nextStep]);
      motion.update((spec.warmup + sweep.nextStep) * spec.frameMs);
      sweep.nextStep++;
    }
    await settle();
    const shot = frameCanvas(canvas, spec.crop);
    const cell = cells.get(sweep.frame);
    if (cell) {
      cell.getContext("2d")!.drawImage(shot, 0, 0, cell.width, cell.height);
    }
    const { row, band } = spec.kymograph;
    kymograph
      .getContext("2d")!
      .drawImage(
        shot,
        0,
        row - Math.floor(band / 2),
        shot.width,
        band,
        0,
        sweep.frame * band,
        shot.width,
        band,
      );
    sweep.frame++;
    const values: Record<string, number> = {
      [spec.parameter]: player.getParameter(spec.parameter),
    };
    for (const id of spec.physicsOutputs) values[id] = player.getParameter(id);
    return { png: shot.toDataURL("image/png"), values };
  },

  async sweepEnd() {
    if (!player || !sweep)
      throw new Error("sweepEnd() called before sweepBegin()");
    const { cell, margin, labelBand, labels } = sweep.spec.sheet;
    const sheet = newCanvas(
      3 * cell.w + 2 * margin,
      3 * (cell.h + labelBand) + 2 * margin,
    );
    const g = sheet.getContext("2d")!;
    // The renders are transparent; a neutral ground keeps the white label
    // legible and reads the same under pale and dark hair.
    g.fillStyle = "#7f7f7f";
    g.fillRect(0, 0, sheet.width, sheet.height);
    g.fillStyle = "#ffffff";
    g.font = `${Math.round(labelBand * 0.6)}px sans-serif`;
    g.textBaseline = "middle";
    sweep.spec.sheet.frames.forEach((k, i) => {
      const x = margin + (i % 3) * cell.w;
      const y = margin + Math.floor(i / 3) * (cell.h + labelBand);
      g.drawImage(sweep!.cells.get(k)!, x, y);
      g.fillText(labels[i], x + 4, y + cell.h + labelBand / 2);
    });
    const out = {
      sheet: sheet.toDataURL("image/png"),
      kymograph: sweep.kymograph.toDataURL("image/png"),
    };
    resetParameters(player);
    sweep = undefined;
    return out;
  },
};
