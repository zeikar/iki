# @ikijs/engine

> Part of [Iki](https://github.com/zeikar/iki), the open Live2D alternative that AI can build — free and MIT-licensed, with an open `.iki` format and a [Claude Code plugin](https://github.com/zeikar/iki/tree/main/plugin) that draws and rigs characters.

WebGL2 runtime that plays a [`.iki`](https://github.com/zeikar/iki/tree/main/packages/format) puppet model in the browser.

The engine is **host-agnostic**: it depends only on
[`@ikijs/format`](https://github.com/zeikar/iki/tree/main/packages/format) and knows nothing about any particular app. A host
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
frame is never half-textured. That swap is also why it must be awaited before
`getParameters()`: an un-awaited `load()` leaves the parameter store empty for
the rest of the tick, and the engine reports that case rather than let a host
read `[]` and conclude the model declares no parameters. Parameter writes are
clamped to the declared range; unknown ids and non-finite values are ignored.

## API

| Export                                           | What it is                                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `IkiPlayer`                                      | The renderer: `load` / `start` / `stop` / `setParameter` / `getParameter` / `getParameters` / `destroy`          |
| `IkiLoadResult`                                  | `{ failedTextures, superseded }` returned by `load()`                                                            |
| `ParameterStore`                                 | The clamped parameter map the player drives                                                                      |
| `IkiMotion`                                      | Idle, clips, expressions, physics and chains, stepped as one; `playExpression` / `stopExpression` / `playMotion` |
| `IdleMotion`                                     | Auto-blink / breath / gaze-drift driver                                                                          |
| `PhysicsMotion`                                  | Spring-mass-damper secondary motion (`model.physics`)                                                            |
| `HairChainMotion`                                | Multi-segment angular chain with gravity (`model.physicsChains`)                                                 |
| `translate` `rotate` `scale` `multiply` `toMat3` | The 2D affine helpers the engine itself uses                                                                     |

## Motion drivers

`IdleMotion`, `PhysicsMotion`, and `HairChainMotion` are **peer drivers**, not
part of the render loop: each is a pure-logic object you `update(nowMs)` once
per frame, and each writes through a sink you supply. That keeps them testable
and lets a host override or omit any of them. `IkiMotion` steps them as one,
with the model's motion clips and expressions in between.

```ts
import { IkiMotion } from "@ikijs/engine";
import { StandardParameter } from "@ikijs/format";

// The drivers read the live pose and write the next one, both through the
// player — no host-side copy of the parameter state to keep in sync.
const motion = new IkiMotion(
  model,
  (id) => player.getParameter(id),
  (id, value) => player.setParameter(id, value),
);

const tick = (now: number) => {
  motion.update(now); // idle, clips, expressions, then physics and chains
  // Signals the host owns go after update(), so they win.
  player.setParameter(StandardParameter.MouthOpen, mouth);
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
```

To stop, stop calling `update()` — the drivers leave the pose where it was,
and `motion.drivenParameterIds` lists every parameter they wrote for a host
that wants to restore it. The three peer drivers are also exported
individually (`IdleMotion`, `PhysicsMotion`, `HairChainMotion`): the two physics
drivers take the same `read`/`sink` pair, `IdleMotion` only the `sink`, and each
is stepped with `update(nowMs)` in that order. Clips and expressions play only
inside `IkiMotion`.

Both physics drivers integrate on a fixed 1/60 s sub-step with a clamped frame
delta, so a backgrounded tab or a long hitch cannot snap the rig.

### Expressions and motion clips

The model is the catalog: a host lists what it can play from
`model.expressions` (ids) and `model.motions` (group names and clip indices).
`IkiMotion` has no getters for them.

- `playExpression(id)` fades the expression in over its `fadeIn` and releases
  the active one over that one's `fadeOut`. One is active at a time; playing
  one that is still fading out brings it back instead of stacking it.
- `stopExpression()` releases the active expression over its `fadeOut`.
- `playMotion(group, index)` starts a clip one-shot, at once. It replaces a
  running one-shot, and the new clip fades in from the old one's last pose.
  There is no queue.

Both `play` methods return `false`, and change nothing, for an id, group or
index the model does not declare.

Each `update(now)` runs in a fixed order: `IdleMotion`, then the `Idle` loop
and the one-shot over it, then expressions, then physics and chains. Physics
reads the head the stages before it just wrote, and owns its outputs: a clip or
expression that writes one is overwritten in the same update. The host writes
the signals it owns (lip-sync, a gaze override) after `update()`, and the last
write wins: an expression that opens the mouth writes `MouthOpen` on every
update, so lip-sync written before `update()` would be overwritten.

A clip or expression composes over a base, never over a parameter's current
value. The base is what an earlier stage wrote in the same update, else the
resting value `clamp(default, min, max)`. So an `add` cannot accumulate across
frames, a `multiply` on `EyeOpen` keeps the blink, and when an expression's
release or a one-shot ends, a parameter nothing else writes rests at its
default.

A model that declares an `Idle` motion group loops its clips in place of the
procedural head sway and gaze (`AngleX/Y/Z`, `EyeballX/Y`); blink and breath
stay procedural. A head or gaze parameter the `Idle` clips don't animate is
left unwritten by idle; a one-shot or an expression can still drive it.

## Rendering notes

- The whole pipeline is **premultiplied alpha** — textures are uploaded
  premultiplied (so LINEAR filtering never blends a transparent texel's rgb
  into an edge), the shader keeps them so, and the canvas is created with
  `premultipliedAlpha: true`.
- Clipping masks use the stencil buffer. If the context grants no stencil, the
  affected parts render unclipped and `load()` logs it.
- Textures are decoded from `data:` URIs only; external URLs are skipped with a
  warning (a resolver is not part of v1).
- Atlas authors should pad / extrude sub-rect borders to avoid LINEAR-filter
  bleeding.

## License

MIT © Zeikar
