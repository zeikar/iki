/**
 * The page script behind `render_poses`: the real engine plus a small
 * load/capture API on `window`. tsup bundles it into a self-contained IIFE
 * (`dist/render-page.global.js`) that Node evaluates into a blank page, so a
 * pose is rendered by the same code a host runs. Browser-only; never imported
 * by the Node bundles.
 */

import { IkiPlayer } from "@ikijs/engine";
import type { IkiModel } from "@ikijs/format";
// Type-only: erased, so nothing from the planner enters the bundle, but the
// page and the planner cannot drift apart.
import type { RenderCrop, RenderPlan } from "./render-poses";

interface IkiRenderApi {
  load(
    model: IkiModel,
    options: Pick<RenderPlan, "canvas" | "view">,
  ): Promise<{ failedTextures: number[] }>;
  capture(values: Record<string, number>, crop?: RenderCrop): Promise<string>;
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
    if (!crop) return canvas.toDataURL("image/png");
    const out = document.createElement("canvas");
    out.width = crop.dw;
    out.height = crop.dh;
    out
      .getContext("2d")!
      .drawImage(
        canvas,
        crop.sx,
        crop.sy,
        crop.sw,
        crop.sh,
        0,
        0,
        crop.dw,
        crop.dh,
      );
    return out.toDataURL("image/png");
  },
};
