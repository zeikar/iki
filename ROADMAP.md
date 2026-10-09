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
   - Torso: `body` rides `bodyWarp` — breath, `BodyAngleX/Y/Z`, a small follow of the head's turn and tilt, legs planted — with the head hung from it
   - Full body — slice 1 (rig foundation) — done: `arm_L` / `arm_R` become an upper arm and a forearm on shoulder and elbow rotations (`ParamArmL/R`, `ParamElbowL/R`), hung from the body warp. Slice 2 (art pipeline) — done: the composer's `canvasHeight` and one mirrored `arm.png`, a 4096 px per-side atlas page, the feet and arm-cap checks, and the plugin's full-body reference drawn from the bust. Slice 3 — done: the first full-body character, drawn end to end through the plugin and shipped by its critic. Finishing slice 1 — done: the plugin fixes, the elbow cap's outlined rim as its own part, the elbow's sign (+ bends toward the body) and the shrunk arm ranges. Finishing slice 2 — done: framing, with the engine's host-owned view (`IkiPlayer.setView`), the playground's full-body frame at 2.5 × the width and the character loop's wider captures. Finishing slice 3 — done: the pose forearm swapped in at the elbow on `ParamArmPoseL/R`, rocked by `ParamArmPoseAngleL/R`, the Wave on models that have it, drawn against a waving reference and validated on the test character. Next: whole-arm poses and a step switch if the crossfade ever shows ghosting. Framing follow-up: the site hero assumes a square bust model (`site/index.html` crop with `aspect-ratio: 1`, `site/hero.ts` `FACE.y` 0.44)
   - Eyelid-style mouth — slice 1 (rig) — done: `mouth_inner` / `lip_lower` / `lip_upper` fold open on MouthOpen like the eyelid (closed = the lips meeting on one line, the lower outline folding with the interior), on one MouthForm frame and one mouth anchor; the legacy crossfade stays byte-identical. Next: slice 2, the composer's keyed split and the plugin's prompts and poses; slice 3, bob's hero on the new mouth.
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
