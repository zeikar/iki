# Roadmap

Where Iki is and where it is going. The short version lives in
[README.md](./README.md); this file is the detail, including what has been
deliberately deferred.

1. **Format + runtime** (parameter-driven color quads) — done
   - **Idle motion** — host-agnostic `IdleMotion` driver (auto-blink / breath / gaze drift / head sway on all three axes) shipped by the engine, consumed by the playground and the editor preview — done
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
   - **5d. Warp-deformer grid keyform authoring by canvas dragging** — done (drag the existing `faceWarp` grid control points to author the `IkiGridWarp` keyform that the head-turn rides). Deferred: per-part `warps` authoring, new deformer types, cols/rows resize, multi-keyform timeline, 2D/multi-driver grids (#4d) — which auto-rigged models now use, so their grid keyforms are not drag-authorable yet.
   - **5e. Matrix-deformer hierarchy authoring (numeric)** — done (select a deformer → edit `pivot` / `transform` / parameter bindings numerically; reparent deformers and attach parts via dropdowns, with cycle / non-matrix-parent / mesh-on-warp validation that fails fast)
   - **5f. Deformer create/delete, canvas pivot gizmo, create-from-scratch** — done
   - **5g. Physics rig authoring** — done (Inspector CRUD over `model.physics` through invertible commands). Deferred: chain (`physicsChains`) authoring.
6. **AI generator** — layered art → auto-rigged `.iki` — done
   - `generateIkiFromLayerSet` (`@ikijs/editor`) rigs role-named layers (`face`, `eye_L/R`, `mouth`, plus optional iris / brow / lash / hair) into a model that blinks, gazes, talks, turns, and emotes
   - PSD import in the editor; the `auto_rig_from_layers` tool in [`@ikijs/mcp`](./packages/mcp) so an agent can go from PNGs to a renderable `.iki` on disk
   - A Claude skill chains image generation → layer compose → rig in one gesture
   - Head-turn depth parallax: the bangs lead the face, the back hair follows at a distance and bends so its near side tucks behind the face — a turn reads as a head rotating rather than a flat cutout sliding
   - Head nod: `AngleY` drives the face warp as one 2D grid warp (`warp2d`) over turn × nod, with a gentler vertical bend so the hair crown stays whole
   - Head tilt: `AngleZ` rolls the head about the neck pivot, clockwise-positive to match Live2D
   - Deferred: ML segmentation of a single flat illustration (today the parts arrive as separate layers)
7. **Physics / secondary motion** — done
   - Spring-mass-damper rigs (`model.physics`) driven by the `PhysicsMotion` peer driver
   - Multi-segment gravity-hung chains (`model.physicsChains`) driven by `HairChainMotion`, for hair strands that lag and swing on a head turn
   - Auto-rig emits hair-sway rigs automatically when a `hair_front` layer is present — one behind the head turn, one behind the tilt — and both hair layers swing on them through root-pinned warps
   - Deferred: warp-aware chains, auto-generated chain rigs
8. **Clipping masks** — done (stencil-based; e.g. an iris clipped to the sclera so it never spills at extreme gaze)
