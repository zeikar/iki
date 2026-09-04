# @ikijs/engine

## 0.1.1

### Patch Changes

- cbb3436: Report an un-awaited `load()` instead of silently reporting no parameters.

  `load()` adopts the model only after decoding its textures, so calling
  `getParameters()` on an un-awaited `load()` returned an empty list. A host
  reasonably concludes the model declares no parameters and drives nothing —
  no error, no motion, nothing to debug. That case now logs once via
  `console.error` naming the fix.

  An un-awaited _reload_ is deliberately not reported: those parameters are stale
  rather than absent, and warning there would fire on legitimate concurrent reads.

## 0.1.0

### Minor Changes

- d28c2d1: Expose the 2D affine helpers (`translate`, `scale`, `rotate`, `multiply`, `toMat3`, and the `Affine` type) from the package root. They were previously private to the player; host adapters can now build transforms against the same math the engine uses.
- 11a5b64: Add atlas + UV-rect textures: optional `textures` on the model and `texture` { index, uv } on parts (back-compat, no IKI_FORMAT_VERSION bump); the engine's `load()` is now async, samples atlas sub-rects with `color` as a tint multiplier, and resolves to an `IkiLoadResult` reporting any textures that failed to load (failed parts are skipped; the rest still render).
- c1487f1: Render clip masks via the WebGL2 stencil buffer. A part carrying `clip.masks` is drawn only where its mask parts' opaque coverage marks the stencil, using each mask's per-frame deformed geometry (so clipping stays correct under warp/gaze deformation). Mask parts still render normally in their own order slot. The context now requests a stencil buffer; if one isn't granted, models that use clipping render unclipped with a console error rather than failing silently.
- 7def749: Rotation deformer + pivot + parent hierarchy (#4a): @ikijs/format adds matrix-only IkiDeformer types (deformers field on model, deformer binding on parts) with validated acyclic hierarchy; @ikijs/engine composes deformer world matrices into the per-part transform chain about a pivot. Additive and optional — existing color/texture-quad models stay valid. Warp mesh, keyform, and per-vertex UV deformation deferred to #4b.
- cd1d168: New `IdleMotion` export: a host-agnostic idle-motion driver that animates the standard "life" parameters — auto-blink on `ParamEyeLOpen`/`ParamEyeROpen`, a breath cycle on `ParamBreath`, and a subtle gaze drift on `ParamEyeBallX`/`ParamEyeBallY`. It is pure logic: the host supplies time via `update(nowMs)` and owns the animation loop; randomness is injectable for deterministic tests. Scheduling runs on an internal clamped-delta clock, so a backgrounded tab can't snap a blink shut or teleport the gaze. Models lacking the standard ids are unaffected (unknown ids are ignored). No `@ikijs/format` change.
- d25f9bb: Multi-segment hair-chain secondary motion + gravity. `@ikijs/format` adds an optional `model.physicsChains` (`IkiPhysicsChain[]`): each chain anchors to a matrix deformer and carries `gravity { angle, strength }` plus ordered `segments[]`, where every segment emits a per-segment rotation output param (θ as displacement-from-rest, in degrees) — validated with path-qualified `IkiFormatError` and cross-checked against the flat `physics[]` rigs (shared id/output uniqueness + output-as-input feedback, plus an implicit anchor-deformer feedback check). `@ikijs/engine` adds a new host-agnostic `HairChainMotion` peer driver (sibling of `PhysicsMotion`; `player.ts` untouched): an angular pendulum chain where each segment is a spring toward rest plus a world-down gravity torque, integrated with the same fixed 1/60 s semi-implicit-Euler discipline + finiteness guards, so a strand bends at its joints and hangs toward world-vertical regardless of head turn. The driver self-computes its anchor's world rotation via `resolveDeformerWorlds`, so hosts only call `update(now)`. Additive — no `IKI_FORMAT_VERSION` bump. A chain follows its anchor's matrix transform only (it does not ride a warp's foreshorten — gravity hair hangs in world space).
- 3c8b66a: `IdleMotion` now drives a gentle head sway on `ParamAngleX` / `ParamAngleY`
  (sums of slow sines, ±3.5° / ±1.6°) alongside blink, breath, and gaze — so an
  idle character keeps drifting instead of freezing solid, and hair physics
  reading the head angle stays alive between interactions. Models without those
  parameters ignore the writes.
- 279928d: `ParameterStore.set` (and therefore `IkiPlayer.setParameter`) now ignores non-finite values instead of storing them. `clamp` could not filter `NaN` — `Math.max(min, Math.min(max, NaN))` is `NaN` — so a single bad host frame (lip-sync, gaze, blink) poisoned the parameter and every binding, transform, and `normalized()` read that followed, with no recovery short of `reset()`. A dropped write now holds the last good pose. Note the behavior change for `±Infinity`: it previously clamped to the range and is now dropped alongside `NaN`, so the boundary applies one rule to all non-finite input. The constructor and `reset()` filter a non-finite declared `default` the same way (falling back to `clamp(0, min, max)`), so `reset()` cannot re-install NaN over good writes — `parseIkiModel` already requires a finite default, so that path only reaches a host building a store from unvalidated descriptors.

  The same rule now applies to the other host-facing entry point: `PhysicsMotion.update(nowMs)` and `HairChainMotion.update(nowMs)` ignore a non-finite timestamp. A NaN frame previously made the fixed-step accumulator NaN, and since `NaN >= step` is false forever after, the rig froze silently with no way back.

- 3441699: Add spring-mass-damper secondary motion. `@ikijs/format` gains an optional, additive `IkiPhysics` rig schema on `IkiModel.physics` — a 1D spring (`input`/`output` parameter refs + `mass`/`stiffness`/`damping`) validated with path-qualified `IkiFormatError` (declared input/output ids, `input !== output`, no duplicate output, no output-as-input feedback, `mass > 0`/`stiffness > 0`/`damping >= 0`). `@ikijs/engine` gains a new `PhysicsMotion` host-agnostic driver — the physics peer of `IdleMotion`: it reads an input parameter, signed-normalizes it around its default × `weight`, integrates a lagging spring with semi-implicit Euler on a fixed 1/60s sub-step accumulator (clamped dt + catch-up cap), and writes `outputDefault + position × scale` onto the output parameter so it lags and overshoots (hair/accessory sway). Spring constants are seconds-based. This is an additive `.iki` change with NO `IKI_FORMAT_VERSION` bump (pre-release v1); playground/example changes are not part of this changeset.
- 2eae3fc: Close four gaps in `IkiPlayer`, and stop keeping two copies of the fixed-timestep integrator.
  - **`getParameter(id)`** — the player exposed `setParameter` and the parameter descriptors, but no way to read a live value, so every host had to shadow the store to feed the motion drivers and hand-maintain a clamp that matched `ParameterStore`. Both examples dropped their mirrors (and their local `clamp`) for this accessor.
  - **`load()` reports oversized and failed texture uploads.** An atlas past the device's `MAX_TEXTURE_SIZE`, or an out-of-memory upload, left a non-null but unsamplable texture that was counted as a success and rendered black. Both are now checked and reported through `failedTextures`.
  - **`IkiLoadResult.superseded`** distinguishes "a newer `load()` overtook this one" from "everything loaded". The losing call returned an empty `failedTextures`, which a caller could not tell from a clean load.
  - **`start()` is a no-op after `destroy()`**, instead of scheduling a render loop against a deleted program and buffers.

  Internally, `clamp` (5 copies), `MAX_DT_MS` (3) and the fixed-step accumulator (2) now live in `math.ts` and `frame-clock.ts`. The physics drivers still do not import from each other; behavior is unchanged.

- f9f5dfa: Warp deformer / group warp (#4c): @ikijs/format adds an `IkiDeformer` discriminated union (`IkiMatrixDeformer` | `IkiWarpDeformer`) with `IkiWarpGrid`/`IkiGridKeyform`/`IkiGridWarp`; a part referencing a `kind:"warp"` deformer must carry a `mesh` (path-qualified validation). @ikijs/engine resolves each warp deformer's deformed control grid per frame (parent matrix affine + single-parameter grid keyforms), binds child mesh vertices to the rest grid, and renders them by bilinear-sampling the deformed grid into the dynamic VBO, bypassing the affine deformer chain. Additive — `kind` omitted means `"matrix"`, so existing #4a/#4b/texture-quad models stay valid (no version bump, pre-release). Bezier/bicubic patches, multi-parameter grid blends, nested warp deformers, and matrix-under-warp are deferred.
- e2f4a89: Warp mesh + per-vertex UV + single-parameter keyform interpolation (#4b): @ikijs/format adds optional `IkiMesh`/`IkiKeyform`/`IkiWarp` types and part `mesh`/`warps` fields (`warps` requires `mesh`) with path-qualified validation; @ikijs/engine renders mesh parts via `drawElements` with per-vertex `a_uv` and applies CPU single-parameter keyform delta interpolation into a dynamic VBO each frame. Additive — existing color/texture-quad and #4a deformer models stay valid and continue through the preserved implicit-quad draw behavior / UV formula (the shared shader gains a mesh branch; the quad branch's output is preserved). 2D parameter grid, multi-parameter warp, and SLERP/non-linear interpolation are deferred.
- 008df01: 2D parameter-grid warp (joint AngleX×AngleY) — second driver via parameter-space bilinear blend (warp2d field).

### Patch Changes

- 62ea5ee: Fix semi-transparent parts rendering darker than specified. The renderer now
  uses a consistent premultiplied-alpha pipeline (shader premultiplies rgb by
  alpha, `ONE / ONE_MINUS_SRC_ALPHA` blending, `premultipliedAlpha: true`
  context). Previously, SRC_ALPHA blending into a straight-alpha canvas eroded
  the framebuffer alpha and composited the page background through
  semi-transparent parts.
- b03198b: Keep esbuild metafiles out of the published tarball. The build now emits `dist/metafile-*.json` so the pre-publish check can prove `@ikijs/format` stays external rather than being inlined into each dependent (a second copy would break `instanceof IkiFormatError` across package boundaries), but that is build introspection: it carries no value for a consumer and leaks local paths.
- e028dd3: `IkiPlayer.load` now reports a lost WebGL context and detects failed mesh-buffer uploads.

  A non-numeric `MAX_TEXTURE_SIZE` has exactly one cause — the context is gone — and the code read that signal and discarded it, then drained the single `CONTEXT_LOST_WEBGL` the spec guarantees. For a model of implicit quads (no mesh parts) the load would then complete and adopt, reporting every texture in `failedTextures` as if they had merely failed to decode. It now says so.

  `bufferData` was also unchecked: only the `createBuffer` allocation was tested for null, so an `OUT_OF_MEMORY` upload left a valid-but-empty buffer that draws garbage or nothing. This class documents a mesh-buffer failure as fatal _because_ it has no `failedTextures`-style reporting surface, which only holds if the failure is detected — it now is, and throws with the existing cleanup.

- c5714cf: Ship `LICENSE` inside each package. Every package declared `"license": "MIT"`, but npm only picks up a package-ROOT licence file and does not follow a symlink, so the repo-root `LICENSE` never reached any tarball — the published artifacts named a licence they did not carry. The pre-publish check now gates on it alongside the README.
- Updated dependencies [11a5b64]
- Updated dependencies [de09cbd]
- Updated dependencies [da7ad77]
- Updated dependencies [2eae3fc]
- Updated dependencies [fddc7af]
- Updated dependencies [7def749]
- Updated dependencies [0a910df]
- Updated dependencies [d25f9bb]
- Updated dependencies [3441699]
- Updated dependencies [c5714cf]
- Updated dependencies [279928d]
- Updated dependencies [f9f5dfa]
- Updated dependencies [e2f4a89]
- Updated dependencies [008df01]
  - @ikijs/format@0.1.0
