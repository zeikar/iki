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
   - **4d. Advanced warp depth** — 2D parameter grids (joint `AngleX`×`AngleY` keyform blend via `warp2d`, true Live2D-style), several 1D grid warps summed on one deformer (one per parameter; `warps` XOR `warp2d`) and matrix deformers under a warp — done. Deferred (revisit when enhancing the look): Bezier/bicubic smooth warp patches (vs. the current bilinear); nested warp deformers; glue / clipping-aware deformation / path deformers; folded-cell detection
5. **Editor** — author parts, meshes, and bindings
   - **5a. Load → numeric part edit → live preview → validated export** — done
   - **5b. Texture/atlas import + per-part UV (quad parts)** — done
   - **5c. Per-part texturing + per-vertex mesh-UV remap** — done (existing face/eyes/mouth meshes take a per-part texture that rides the warp). Deferred to a later slice: mesh topology editing (triangulation / vertex add-move-delete / quad→mesh) and base-UV persistence across reload.
   - **5d. Warp-deformer grid keyform authoring by canvas dragging** — done (drag the existing `faceWarp` grid control points to author the `IkiGridWarp` keyform that the head-turn rides). Deferred: per-part `warps` authoring, new deformer types, cols/rows resize, multi-keyform timeline, 2D/multi-driver grids (#4d) — which auto-rigged models now use, so their grid keyforms are not drag-authorable yet.
   - **5e. Matrix-deformer hierarchy authoring (numeric)** — done (select a deformer → edit `pivot` / `transform` / parameter bindings numerically; reparent deformers and attach parts via dropdowns, with cycle / warp-under-warp / mesh-on-warp validation that fails fast)
   - **5f. Deformer create/delete, canvas pivot gizmo, create-from-scratch** — done
   - **5g. Physics rig authoring** — done (Inspector CRUD over `model.physics` through invertible commands). Deferred: chain (`physicsChains`) authoring.
6. **AI generator** — layered art → auto-rigged `.iki` — done
   - `generateIkiFromLayerSet` (`@ikijs/editor`) rigs role-named layers (`face`, `eye_L/R`, `mouth`, plus optional iris / brow / lash / hair) into a model that blinks, gazes, talks, turns, and emotes
   - PSD import in the editor; the `auto_rig_from_layers` tool in [`@ikijs/mcp`](./packages/mcp) so an agent can go from PNGs to a renderable `.iki` on disk
   - A Claude skill chains image generation → layer compose → rig in one gesture
   - Head turn as parallax, by a profile of our own values picked by eye: the face plate translates, the chin and the features lead it, the front hair rides the face and holds the head's outline where it draws it, and the back hair stays behind
   - Neck and ears: the ones the face layer paints are cut into islands of the plate's own mesh, drawn behind the head — the neck stays under the sliding chin, the ears lag the face
   - Head nod: `AngleY` moves each region by the profile's own values
   - Head tilt: `AngleZ` rolls the head 14° about the chin, clockwise-positive to match Live2D
   - Torso: `body` rides a `bodyDeformer` that only breathes — a turn leaves it where it is
   - Keyforms at 0 and ±30 only, since every profile curve is linear in its angle: each feature family rides its own `warp2d` grid over the 3×3 of turn × nod, and the plate, the blush and both hair layers carry their own keyforms
   - Per-character `style` knobs scale the profile: the turn's amount, the features' lead, how far the front hair follows the face and at the outline, the blink and the sway
   - Deferred: ML segmentation of a single flat illustration (today the parts arrive as separate layers)
7. **Physics / secondary motion** — done
   - Spring-mass-damper rigs (`model.physics`) driven by the `PhysicsMotion` peer driver
   - Multi-segment gravity-hung chains (`model.physicsChains`) driven by `HairChainMotion`, for hair strands that lag and swing on a head turn
   - Auto-rig emits hair-sway rigs automatically when a `hair_front` layer is present — one behind the head turn, one behind the tilt — and both hair layers swing on them through root-pinned warps
   - Deferred: warp-aware chains, auto-generated chain rigs
8. **Clipping masks** — done (stencil-based; e.g. an iris clipped to the sclera so it never spills at extreme gaze)
9. **Expressions and motions** — in progress
   - Slice 1 — done: optional `expressions` and `motions` in the `.iki` format, the engine players on `IkiMotion`, and play buttons in the playground
   - Slice 2 — done: `ParamCheek` fades an auto-rigged blush from faint at rest to as drawn; every auto-rigged model declares the Nod, Shake and Tilt head motions and up to six described default expressions (smile, laugh, angry, sad, surprised, shy — each only where the face has the parts it shows), their values picked by eye on our own characters; the playground hero wears a blush and ships its own set
   - Next: the Charivo adapter
   - Deferred: EyeSmile, the happy eye for smile and laugh (it needs a part-level 2D warp, keyed on EyeOpen × EyeSmile)
