# Iki

[![Built with HyperClaude](https://img.shields.io/badge/Built%20with-HyperClaude-D97757?logo=anthropic&logoColor=white)](http://zeikar.dev/hyperclaude/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> 息 (breath) · 生き (life) · 粋 (chic)

**Iki** is an open 2D rig puppet animation engine for the web — a from-scratch
alternative to Live2D and [Inochi2D](https://inochi2d.com/). You author a
character as layered parts wired to a small set of parameters, and the runtime
animates it in WebGL. A host (such as [Charivo](https://github.com/zeikar/charivo))
drives those parameters from lip-sync, gaze, blink, and expressions.

> Status: **early / from scratch.** The runtime renders parameter-driven
> color quads, atlas-sampled texture parts, and warp-mesh deformation today.
> The editor and the AI generator are the milestones ahead.

## Why

- **Open format.** The `.iki` model is a plain, documented schema you own —
  which is what makes AI-driven model generation tractable.
- **Web-native.** WebGL runtime, TypeScript, no native toolchain.
- **Host-agnostic.** The engine knows nothing about Charivo or any host; it
  just plays `.iki` models. Charivo consumes it through a thin `render-iki`
  adapter, the same way it consumes the Live2D SDK today.

## Packages

| Package                                        | What it is                                                                                                                                                           |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@iki/format`](./packages/format)             | The `.iki` model schema, types, loader, and validator                                                                                                                |
| [`@iki/engine`](./packages/engine)             | WebGL2 runtime that plays a `.iki` model                                                                                                                             |
| [`@iki/editor-core`](./packages/editor-core)   | DOM-free editing core: EditorDocument, part-edit commands, undo/redo, atlas layout/UV helpers, toIkiModel/serialize round-trip (depends only on @iki/format)         |
| [`examples/playground`](./examples/playground) | Slider-driven demo of a hand-authored model                                                                                                                          |
| [`examples/editor`](./examples/editor)         | Private React+Zustand app — load sample model, numeric part edit, per-part texture drop (quad + mesh, rides the warp), live IkiPlayer preview, validated .iki export |

## Quick start

```bash
pnpm install
pnpm build
pnpm playground   # open the Vite URL and drag the sliders
```

## The `.iki` model

A model is a flat list of parts composited back-to-front, plus parameters wired
to those parts through linear bindings:

```ts
import { StandardParameter, type IkiModel } from "@iki/format";

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
any host can drive any model without per-model wiring.

> **Stability:** pre-release — the `.iki` format may change without an
> `IKI_FORMAT_VERSION` bump until the first published release. After that,
> breaking schema changes bump the version.

## Roadmap

1. **Format + runtime** (parameter-driven color quads) — done
2. **Charivo adapter** — `@charivo/render-iki` implementing the renderer contract
3. **Textures** — atlas + UV-rect texture sampling, `color` as tint multiplier — done
   > Atlas authors should add padding / extruded borders between sub-rects to avoid LINEAR-filter bleeding.
4. **Warp/rotation deformers** — the soft 2.5D head-turn that defines the look
   - **4a. Rotation deformer + pivot + parent hierarchy** — done
   - **4b. Warp mesh, keyform, per-vertex UV** — done
   - **4c. Warp deformer (group warp)** — done
   - **4d. Advanced warp depth** — deferred (revisit when enhancing the look): 2D parameter grids (joint `AngleX`×`AngleY` keyform blend, true Live2D-style) + multi-driver grid composition; Bezier/bicubic smooth warp patches (vs. the current bilinear); nested warp deformers + matrix-under-warp hierarchies; glue / clipping-aware deformation / path deformers; folded-cell detection
5. **Editor** — author parts, meshes, and bindings
   - **5a. Load → numeric part edit → live preview → validated export** — done
   - **5b. Texture/atlas import + per-part UV (quad parts)** — done
   - **5c. Per-part texturing + per-vertex mesh-UV remap** — done (existing face/eyes/mouth meshes take a per-part texture that rides the warp). Deferred to a later slice: mesh topology editing (triangulation / vertex add-move-delete / quad→mesh) and base-UV persistence across reload.
   - **5d. Warp-deformer grid keyform authoring by canvas dragging** — done (drag the existing `faceWarp` grid control points to author the `IkiGridWarp` keyform that the head-turn rides). Deferred: per-part `warps` authoring, new deformer types, cols/rows resize, multi-keyform timeline, 2D/multi-driver grids (#4d).
   - **5e. Matrix-deformer hierarchy authoring (numeric)** — done (select a deformer → edit `pivot` / `transform` / parameter bindings numerically; reparent deformers and attach parts via dropdowns, with cycle / non-matrix-parent / mesh-on-warp validation that fails fast). Deferred: canvas pivot gizmo, creating/deleting deformers.
6. **AI generator** — image → segmented parts → auto-rigged `.iki`

## License

MIT © Zeikar

---

**Built with [HyperClaude](http://zeikar.dev/hyperclaude/)** — _Claude builds, Codex critiques._
