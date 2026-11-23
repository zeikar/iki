import { afterEach, describe, expect, it, vi } from "vitest";
import type { IkiModel } from "@ikijs/format";
import { IkiPlayer } from "@ikijs/engine";

// --- Test harness -------------------------------------------------------------

/**
 * A WebGL2 context that accepts every call: no error is ever latched, every
 * compile and link succeeds, every create hands back a fresh object. Enough
 * for load() to adopt a model; nothing is drawn.
 */
function fakeGl(): WebGL2RenderingContext {
  const answers: Record<string, () => unknown> = {
    getContextAttributes: () => ({ stencil: true }),
    getError: () => 0,
    getParameter: () => 4096,
    getProgramParameter: () => true,
    getShaderParameter: () => true,
    getAttribLocation: () => 0,
  };
  return new Proxy({} as WebGL2RenderingContext, {
    get: (_, prop) => {
      if (typeof prop !== "string") return undefined;
      if (prop in answers) return answers[prop];
      // An enum: NO_ERROR has to match getError's 0, the rest only exist.
      if (/^[A-Z0-9_]+$/.test(prop)) return prop === "NO_ERROR" ? 0 : 1;
      return () => ({});
    },
  });
}

function newPlayer(): IkiPlayer {
  return new IkiPlayer({
    getContext: () => fakeGl(),
  } as unknown as HTMLCanvasElement);
}

/** A model whose only parameter is `id`, with one texture when `textured`. */
function model(id: string, textured = false): IkiModel {
  return {
    version: 1,
    name: id,
    canvas: { width: 100, height: 100 },
    parameters: [{ id, min: 0, max: 1, default: 0.5 }],
    parts: [],
    ...(textured
      ? { textures: [{ source: "data:image/png;base64,AAAA" }] }
      : {}),
  };
}

/**
 * Hold every texture decode until `release()`, so a textured load stays in
 * flight. Node has no createImageBitmap; the stub stands in for it.
 */
function holdDecodes(): { release: () => void; bitmap: { close: () => void } } {
  const bitmap = { width: 1, height: 1, close: vi.fn() };
  let release = (): void => {};
  const decoded = new Promise<typeof bitmap>((resolve) => {
    release = () => resolve(bitmap);
  });
  vi.stubGlobal("createImageBitmap", () => decoded);
  return { release, bitmap };
}

const ids = (player: IkiPlayer): string[] =>
  player.getParameters().map((p) => p.id);

// --- Tests ---------------------------------------------------------------------

describe("IkiPlayer.cancelLoad", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("supersedes a pending load: it adopts nothing and the installed model stays", async () => {
    const player = newPlayer();
    await player.load(model("A"));
    const { release, bitmap } = holdDecodes();

    const pending = player.load(model("B", true));
    player.cancelLoad();
    release();

    expect(await pending).toEqual({ failedTextures: [], superseded: true });
    expect(ids(player)).toEqual(["A"]);
    expect(player.getParameter("A")).toBe(0.5);
    // The decoded bitmap is released, as for a load a newer one superseded.
    expect(bitmap.close).toHaveBeenCalled();
  });

  it("is a no-op with nothing pending", async () => {
    const player = newPlayer();
    await player.load(model("A"));
    player.setParameter("A", 0.9);

    player.cancelLoad();

    expect(ids(player)).toEqual(["A"]);
    expect(player.getParameter("A")).toBe(0.9);
  });

  it("a load started after it adopts as usual", async () => {
    const player = newPlayer();
    await player.load(model("A"));
    const { release } = holdDecodes();
    const cancelled = player.load(model("B", true));
    player.cancelLoad();

    const next = player.load(model("C", true));
    release();

    expect((await cancelled).superseded).toBe(true);
    expect(await next).toEqual({ failedTextures: [], superseded: false });
    expect(ids(player)).toEqual(["C"]);
  });

  it("with no model installed yet, the cancelled load leaves the player empty and the next one adopts", async () => {
    const player = newPlayer();
    const { release } = holdDecodes();
    const pending = player.load(model("B", true));
    player.cancelLoad();
    release();

    expect(await pending).toEqual({ failedTextures: [], superseded: true });
    expect(ids(player)).toEqual([]);
    expect((await player.load(model("A"))).superseded).toBe(false);
    expect(ids(player)).toEqual(["A"]);
  });

  it("destroy() after it still tears down, and the cancelled load stays superseded", async () => {
    const player = newPlayer();
    await player.load(model("A"));
    const { release, bitmap } = holdDecodes();
    const pending = player.load(model("B", true));
    player.cancelLoad();
    player.destroy();
    release();

    expect(await pending).toEqual({ failedTextures: [], superseded: true });
    expect(bitmap.close).toHaveBeenCalled();
    // A destroyed player adopts nothing more.
    expect((await player.load(model("C"))).superseded).toBe(true);
  });
});
