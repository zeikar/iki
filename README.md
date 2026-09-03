# Iki

[![Built with HyperClaude](https://img.shields.io/badge/Built%20with-HyperClaude-D97757?logo=anthropic&logoColor=white)](http://zeikar.dev/hyperclaude/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> 息 (breath) · 生き (life) · 粋 (chic)

**Iki** is an open 2D rig puppet animation engine for the web — a from-scratch
alternative to Live2D and [Inochi2D](https://inochi2d.com/). You author a
character as layered parts wired to a small set of parameters, and the runtime
animates it in WebGL. A host (such as [Charivo](https://github.com/zeikar/charivo))
drives those parameters from lip-sync, gaze, blink, and expressions.

> Status: **early, but real.** The runtime renders parameter-driven color quads,
> atlas-sampled texture parts, warp-mesh and grid deformation, stencil clipping
> masks, and spring/chain physics. The editor authors parts, deformers, and
> physics rigs; the generator rigs a character from role-named PNG/PSD layers,
> including through an MCP server that AI agents can drive.

## Why

- **Open format.** The `.iki` model is a plain, documented schema you own —
  which is what makes AI-driven model generation tractable.
- **Web-native.** WebGL runtime, TypeScript, no native toolchain.
- **Host-agnostic.** The engine knows nothing about Charivo or any host; it
  just plays `.iki` models. Charivo consumes it through a thin `render-iki`
  adapter, the same way it consumes the Live2D SDK today.

## Packages

| Package                                        | What it is                                                                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@ikijs/format`](./packages/format)           | The `.iki` model schema, types, loader, and validator                                                                                              |
| [`@ikijs/engine`](./packages/engine)           | WebGL2 runtime that plays a `.iki` model                                                                                                           |
| [`@ikijs/editor-core`](./packages/editor-core) | DOM-free editing core: EditorDocument, edit commands, undo/redo, atlas layout/UV helpers, auto-rigger (depends only on @ikijs/format)              |
| [`@ikijs/mcp`](./packages/mcp)                 | stdio MCP server exposing `.iki` read/validate plus `auto_rig_from_layers` to AI agents                                                            |
| [`examples/playground`](./examples/playground) | Slider-driven demo of a hand-authored model                                                                                                        |
| [`examples/editor`](./examples/editor)         | Private React+Zustand app — load/import art, numeric part + deformer + physics editing, pivot gizmo, live IkiPlayer preview, validated .iki export |

## Install

```bash
npm install @ikijs/engine @ikijs/format
```

`@ikijs/editor-core` is for building authoring tools; `@ikijs/mcp` runs as a
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

> **Stability:** `IKI_FORMAT_VERSION` identifies the `.iki` contract and any
> breaking schema change bumps it. The npm packages are pre-1.0, so the
> TypeScript surface around that contract can still shift between minors.

## Roadmap

1. **Format + runtime** (parameter-driven color quads) — done
   - **Idle motion** — host-agnostic `IdleMotion` driver (auto-blink / breath / gaze drift) shipped by the engine, consumed by the playground and the editor preview — done
2. **Charivo adapter** — [`@charivo/render-iki`](https://github.com/zeikar/charivo/tree/main/packages/render-iki) implementing the renderer contract — working as a private local-dogfood package in the Charivo repo
3. **Textures** — atlas + UV-rect texture sampling, `color` as tint multiplier — done
   > Atlas authors should add padding / extruded borders between sub-rects to avoid LINEAR-filter bleeding.
4. **Warp/rotation deformers** — the soft 2.5D head-turn that defines the look
   - **4a. Rotation deformer + pivot + parent hierarchy** — done
   - **4b. Warp mesh, keyform, per-vertex UV** — done
   - **4c. Warp deformer (group warp)** — done
   - **4d. Advanced warp depth** — 2D parameter grids (joint `AngleX`×`AngleY` keyform blend via `warp2d`, true Live2D-style) — done. Deferred (revisit when enhancing the look): multi-driver grid composition; Bezier/bicubic smooth warp patches (vs. the current bilinear); nested warp deformers + matrix-under-warp hierarchies; glue / clipping-aware deformation / path deformers; folded-cell detection
5. **Editor** — author parts, meshes, and bindings
   - **5a. Load → numeric part edit → live preview → validated export** — done
   - **5b. Texture/atlas import + per-part UV (quad parts)** — done
   - **5c. Per-part texturing + per-vertex mesh-UV remap** — done (existing face/eyes/mouth meshes take a per-part texture that rides the warp). Deferred to a later slice: mesh topology editing (triangulation / vertex add-move-delete / quad→mesh) and base-UV persistence across reload.
   - **5d. Warp-deformer grid keyform authoring by canvas dragging** — done (drag the existing `faceWarp` grid control points to author the `IkiGridWarp` keyform that the head-turn rides). Deferred: per-part `warps` authoring, new deformer types, cols/rows resize, multi-keyform timeline, 2D/multi-driver grids (#4d).
   - **5e. Matrix-deformer hierarchy authoring (numeric)** — done (select a deformer → edit `pivot` / `transform` / parameter bindings numerically; reparent deformers and attach parts via dropdowns, with cycle / non-matrix-parent / mesh-on-warp validation that fails fast)
   - **5f. Deformer create/delete, canvas pivot gizmo, create-from-scratch** — done
   - **5g. Physics rig authoring** — done (Inspector CRUD over `model.physics` through invertible commands). Deferred: chain (`physicsChains`) authoring.
6. **AI generator** — layered art → auto-rigged `.iki` — done
   - `generateIkiFromLayerSet` (`@ikijs/editor-core`) rigs role-named layers (`face`, `eye_L/R`, `mouth`, plus optional iris / brow / lash / hair) into a model that blinks, gazes, talks, turns, and emotes
   - PSD import in the editor; the `auto_rig_from_layers` tool in [`@ikijs/mcp`](./packages/mcp) so an agent can go from PNGs to a renderable `.iki` on disk
   - A Claude skill chains image generation → layer compose → rig in one gesture
   - Deferred: ML segmentation of a single flat illustration (today the parts arrive as separate layers)
7. **Physics / secondary motion** — done
   - Spring-mass-damper rigs (`model.physics`) driven by the `PhysicsMotion` peer driver
   - Multi-segment gravity-hung chains (`model.physicsChains`) driven by `HairChainMotion`, for hair strands that lag and swing on a head turn
   - Auto-rig emits a hair-sway rig automatically when a `hair_front` layer is present
   - Deferred: warp-aware chains, auto-generated chain rigs
8. **Clipping masks** — done (stencil-based; e.g. an iris clipped to the sclera so it never spills at extreme gaze)

## License

MIT © Zeikar

---

**Built with [HyperClaude](http://zeikar.dev/hyperclaude/)** — _Claude builds, Codex critiques._
