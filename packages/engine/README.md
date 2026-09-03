# @ikijs/engine

WebGL2 runtime that plays a [`.iki`](../format) puppet model in the browser.

The engine is **host-agnostic**: it depends only on
[`@ikijs/format`](../format) and knows nothing about any particular app. A host
drives it by setting parameters (from lip-sync, gaze, blink, expressions); the
engine renders the result each frame.

## Install

```bash
npm install @ikijs/engine @ikijs/format
```

## Usage

```ts
import { IkiPlayer } from "@ikijs/engine";
import { loadIkiModel, StandardParameter } from "@ikijs/format";

const player = new IkiPlayer(canvas); // HTMLCanvasElement
const result = await player.load(loadIkiModel(json));
if (result.failedTextures.length > 0) {
  console.warn("some textures failed", result.failedTextures);
}
player.start();

player.setParameter(StandardParameter.MouthOpen, 0.7);
```

`load()` decodes and uploads every texture before swapping the model in, so a
frame is never half-textured. Parameter writes are clamped to the declared
range; unknown ids and non-finite values are ignored.

## API

| Export                                           | What it is                                                                             |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `IkiPlayer`                                      | The renderer: `load` / `start` / `stop` / `setParameter` / `getParameters` / `destroy` |
| `IkiLoadResult`                                  | `{ failedTextures: number[] }` returned by `load()`                                    |
| `ParameterStore`                                 | The clamped parameter map the player drives                                            |
| `IdleMotion`                                     | Auto-blink / breath / gaze-drift driver                                                |
| `PhysicsMotion`                                  | Spring-mass-damper secondary motion (`model.physics`)                                  |
| `HairChainMotion`                                | Multi-segment angular chain with gravity (`model.physicsChains`)                       |
| `translate` `rotate` `scale` `multiply` `toMat3` | The 2D affine helpers the engine itself uses                                           |

## Motion drivers

`IdleMotion`, `PhysicsMotion`, and `HairChainMotion` are **peer drivers**, not
part of the render loop: each is a pure-logic object you `update(nowMs)` once
per frame, and each writes through a sink you supply. That keeps them testable
and lets a host override or omit any of them.

```ts
import { HairChainMotion, IdleMotion, PhysicsMotion } from "@ikijs/engine";

// The drivers read and write parameters through the host, so keep a mirror of
// the current pose alongside the player.
const current = new Map<string, number>();
const drive = (id: string, value: number) => {
  current.set(id, value);
  player.setParameter(id, value);
};

const idle = new IdleMotion(drive);
const physics = new PhysicsMotion(
  model.physics ?? [],
  model.parameters,
  (id) => current.get(id) ?? 0,
  drive,
);
const chains = new HairChainMotion(
  model.physicsChains ?? [],
  model.parameters,
  model.deformers ?? [],
  (id) => current.get(id) ?? 0,
  drive,
);

const tick = (now: number) => {
  idle.update(now);
  physics.update(now); // reads what idle just wrote
  chains.update(now);
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
```

Both physics drivers integrate on a fixed 1/60 s sub-step with a clamped frame
delta, so a backgrounded tab or a long hitch cannot snap the rig.

## Rendering notes

- The whole pipeline is **premultiplied alpha** — the canvas is created with
  `premultipliedAlpha: true` and the shader premultiplies before blending.
- Clipping masks use the stencil buffer. If the context grants no stencil, the
  affected parts render unclipped and `load()` logs it.
- Textures are decoded from `data:` URIs only; external URLs are skipped with a
  warning (a resolver is not part of v1).
- Atlas authors should pad / extrude sub-rect borders to avoid LINEAR-filter
  bleeding.

## License

MIT © Zeikar
