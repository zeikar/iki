# Iki

[![@ikijs/engine on npm](https://img.shields.io/npm/v/@ikijs/engine?label=%40ikijs%2Fengine&color=cb3837&logo=npm)](https://www.npmjs.com/package/@ikijs/engine)
[![@ikijs/format on npm](https://img.shields.io/npm/v/@ikijs/format?label=%40ikijs%2Fformat&color=cb3837&logo=npm)](https://www.npmjs.com/package/@ikijs/format)
[![@ikijs/mcp on npm](https://img.shields.io/npm/v/@ikijs/mcp?label=%40ikijs%2Fmcp&color=cb3837&logo=npm)](https://www.npmjs.com/package/@ikijs/mcp)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757?logo=anthropic&logoColor=white)](./plugin)
[![Live demo](https://img.shields.io/badge/demo-zeikar.dev%2Fiki-E9A23B)](https://zeikar.dev/iki/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Built with HyperClaude](https://img.shields.io/badge/Built%20with-HyperClaude-D97757?logo=anthropic&logoColor=white)](http://zeikar.dev/hyperclaude/)

<p align="center">
  <img src="./.github/assets/hero.gif" width="360" alt="An Iki character turning its head, blinking and talking, rendered by the engine." />
  <br />
  <sub>Parts drawn by an image model and rigged by Iki's auto-rigger, with no hand rigging. <a href="https://zeikar.dev/iki/">See it live</a>.</sub>
</p>

<h3 align="center">The open Live2D alternative that AI can build.</h3>

> 息 (breath) · 生き (life) · 粋 (chic)

**Iki** is a free, MIT-licensed 2D puppet animation engine for the web — an
alternative to Live2D and [Inochi2D](https://inochi2d.com/) whose characters an
AI agent can make. Ask for one, and the bundled
[Claude Code plugin](./plugin) has an image model draw its parts, then rigs them
into a character that blinks, looks around, talks, turns and nods, with hair
that sways. What you get is an open `.iki` file — plain JSON you own — that the
WebGL runtime plays in any browser, and that a host (such as
[Charivo](https://github.com/zeikar/charivo)) drives from lip-sync, gaze and
expressions.

> Status: **early, but real.** The runtime renders parameter-driven color quads,
> atlas-sampled texture parts, warp-mesh and grid deformation, stencil clipping
> masks, and spring/chain physics. The editor authors parts, deformers, and
> physics rigs; the generator rigs a character from role-named PNG/PSD layers,
> including through an MCP server that AI agents can drive.

## Make a character with AI

Install the plugin in [Claude Code](https://github.com/anthropics/claude-code):

```
/plugin marketplace add zeikar/iki
/plugin install iki@iki
```

Then ask for a character — _"make me an iki character: short copper bob, green
eyes, school uniform"_. The plugin:

1. **Draws** each part on its own with an image model — face, eyes, irises,
   brows, mouth, nose, front and back hair, torso.
2. **Composes and checks** them on one canvas (`compose_layers_from_parts`,
   `measure_layers`), catching the geometry that would break in motion.
3. **Rigs** them (`auto_rig_from_layers`): eyelid-fold blink, gaze, lip-sync,
   head turn, nod and tilt, brows, breathing and hair physics, written to a
   `.iki` model.

The character at the top of this page was made this way. The plugin needs an
image generator — see its [prerequisites](./plugin#prerequisites). Already have
art? Hand role-named PNG layers to the auto-rigger through the
[`@ikijs/mcp`](./packages/mcp) server, or import a layered PSD in the editor.

## Try it

No install — both demos run in the browser:

- **[Playground](https://zeikar.dev/iki/playground/)** — drag the sliders
  that a host would drive, on a hand-authored model or a generated character.
- **[Editor](https://zeikar.dev/iki/editor/)** — author parts, deformers,
  and physics rigs, import a layered PSD, and export a validated `.iki`.

## Why

- **Characters an AI agent can build.** Part images in, a rigged model that
  blinks, talks, turns and nods out — through the Claude Code plugin or any MCP
  client. That is the part Iki is really exploring.
- **Free for commercial use.** MIT: no publication license, no revenue tiers —
  ship whatever you build with it.
- **Open format.** The `.iki` model is a plain, documented JSON schema you own —
  which is what makes generating a model tractable in the first place.
- **Web-native.** WebGL runtime, TypeScript, no native toolchain.
- **Host-agnostic.** The engine knows nothing about Charivo or any host; it
  just plays `.iki` models. Charivo consumes it through a thin `render-iki`
  adapter, the same way it consumes the Live2D SDK today.

## How Iki compares

Live2D Cubism is the industry standard, and it is far more mature than Iki in
every dimension that matters to an artist — editor, tooling, ecosystem, and the
quality ceiling of what you can rig with it. [Inochi2D](https://inochi2d.com/)
is the established open-source project in this space. Iki is not trying to
replace either. It exists because three things it wanted never lined up in one
place: a permissive license, a plain-text format, and a rig an agent can build.

|                          | Live2D Cubism                                                                                                                                            | Inochi2D                     | Iki                                                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| License                  | Proprietary SDK license; a publication license is required to distribute, with exemptions for individuals and small businesses ([terms][live2d-license]) | BSD-2-Clause                 | **MIT** — free for commercial use                                                                                                                                               |
| Editor                   | Cubism Editor (paid PRO tier, free tier)                                                                                                                 | Inochi Creator (open source) | Headless editor core + example app (early)                                                                                                                                      |
| Model format             | `.moc3`, compiled and proprietary                                                                                                                        | Open                         | Plain JSON with a documented schema and a validator                                                                                                                             |
| Runtime                  | Native SDKs, including a Web SDK                                                                                                                         | Native (D)                   | TypeScript + WebGL2, `npm install`                                                                                                                                              |
| An AI agent can build it | —                                                                                                                                                        | —                            | Yes: a Claude Code plugin that draws and rigs a character, over an MCP server (`compose_layers_from_parts`, `measure_layers`, `auto_rig_from_layers`, `measure_turn_reference`) |
| Maturity                 | Industry standard                                                                                                                                        | Established                  | Early (0.x, schema still settling)                                                                                                                                              |

[live2d-license]: https://www.live2d.com/en/sdk/license/

If you need production-grade 2D rigging today, use Cubism. If you want an open
web format you can script against, that is what this is.

## Packages

| Package                                                                                     | What it is                                                                                                                                                          |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@ikijs/format`](./packages/format)                                                        | The `.iki` model schema, types, loader, and validator                                                                                                               |
| [`@ikijs/engine`](./packages/engine)                                                        | WebGL2 runtime that plays a `.iki` model                                                                                                                            |
| [`@ikijs/editor`](./packages/editor)                                                        | Headless editing core (no UI): EditorDocument, edit commands, undo/redo, atlas layout/UV helpers, auto-rigger (depends only on @ikijs/format)                       |
| [`@ikijs/mcp`](./packages/mcp)                                                              | stdio MCP server exposing `.iki` read/validate plus `compose_layers_from_parts`, `measure_layers`, `auto_rig_from_layers` and `measure_turn_reference` to AI agents |
| [`examples/playground`](./examples/playground) ([live](https://zeikar.dev/iki/playground/)) | Slider-driven demo of the generated hero character and a hand-authored model                                                                                        |
| [`examples/editor`](./examples/editor) ([live](https://zeikar.dev/iki/editor/))             | Private React+Zustand app — load/import art, numeric part + deformer + physics editing, pivot gizmo, live IkiPlayer preview, validated .iki export                  |
| [`plugin/`](./plugin)                                                                       | Claude Code plugin — the character-generation skills, their two agents, and the MCP server, wired up in one install                                                 |

## Install

```bash
npm install @ikijs/engine @ikijs/format
```

`@ikijs/editor` is for building authoring tools; `@ikijs/mcp` runs as a
server (`npx -y @ikijs/mcp`) rather than being imported.

## Quick start (this repo)

```bash
pnpm install
pnpm build
pnpm playground   # open the Vite URL and drag the sliders
```

## The `.iki` model

A model is a flat list of parts composited back-to-front, plus parameters wired
to those parts through linear bindings:

```ts
import { StandardParameter, type IkiModel } from "@ikijs/format";

const model: IkiModel = {
  version: 1,
  name: "Hello",
  canvas: { width: 1000, height: 1000 },
  parameters: [{ id: StandardParameter.MouthOpen, min: 0, max: 1, default: 0 }],
  parts: [
    {
      id: "mouth",
      color: [0.78, 0.32, 0.36, 1], // solid fill, or tint multiplier when a texture is present
      width: 150,
      height: 34,
      order: 0,
      transform: { x: 0, y: -150 },
      bindings: [
        {
          parameter: StandardParameter.MouthOpen,
          channel: "scaleY",
          from: 0,
          to: 3,
        },
      ],
    },
  ],
};
```

Stick to the `StandardParameter` ids (`ParamMouthOpenY`, `ParamAngleX`, …) so
any host can drive any model without per-model wiring. `Left`/`Right` in those
ids name the **character's** side, so the character's left eye is the part at
positive x (the viewer's right).

A model can also declare expressions and motion clips, each with a description.
A host plays an expression by its id and a clip by its group and index.

> **Stability:** `IKI_FORMAT_VERSION` identifies the `.iki` contract, and from
> 1.0 on, any breaking schema change bumps it. Until then the v1 schema is still
> settling: a 0.x release may tighten validation and reject a model an earlier
> one accepted (canvas extents must now be `> 0`, for instance). Such changes
> are called out in the changelog. The TypeScript surface can likewise shift
> between 0.x minors.

## FAQ

**Can I use this commercially?** Yes — MIT, for everything in this repo. Models
you make are yours.

**Can it load Live2D models?** No. `.moc3` is a proprietary compiled format;
Iki has its own open schema and no importer for it.

**Is it production ready?** Not yet — the packages are published from 0.1.0 and
the v1 schema is still settling. See **Stability** above for what that means for
a model you save today.

**Do I need the editor to use it?** No. `@ikijs/engine` + `@ikijs/format` are
enough to play a model. The editor packages are for building authoring tools.

**How do I make a model?** Ask for one with the
[Claude Code plugin](#make-a-character-with-ai), which draws the parts and rigs
them. With art of your own, feed role-named PNG layers to the auto-rigger in
[`@ikijs/editor`](./packages/editor) / [`@ikijs/mcp`](./packages/mcp), which
wires up blink, gaze, lip-sync, head-turn and brows for you. Or hand-write the
JSON — it is small, see above.

## Roadmap

[ROADMAP.md](./ROADMAP.md) tracks what has landed and what is deferred.

## License

MIT © Zeikar

---

**Built with [HyperClaude](http://zeikar.dev/hyperclaude/)** — _Claude builds, Codex critiques._
