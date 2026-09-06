# @ikijs/format

## 0.2.0

### Minor Changes

- 64617a7: Head tilt reaches the idle motion and the hair.
  - `@ikijs/engine`: `IdleMotion` now sways `ParamAngleZ` too — the smallest and
    slowest of the three head axes (±1.1° over 11.3 s), so an idle character
    tilts as gently as it breathes. Models without the parameter ignore the
    writes, as with AngleX/Y.
  - `@ikijs/format`: adds `StandardParameter.HairSwayZ` (`ParamHairSwayZ`), a
    physics output for hair swinging behind a head tilt, alongside `HairSwayX`.
  - `@ikijs/editor`: when a `hair_front` layer is present the auto-rigger now
    emits a second spring rig, `hairTilt`, that lags `AngleZ` onto `HairSwayZ`
    and declares the parameter. Two rigs because a rig has exactly one input
    and one output. Hair sway is no longer a `rotate`/`translateX` binding on
    the front hair — parts have no pivot, so that turned the bangs about their
    centre and lifted the roots off the hairline. Both hair layers now carry
    root-pinned sway warps (`bakeHairSwayWarp`, exported) on `HairSwayX` and
    `HairSwayZ`: the top row stays put and the ends swing 9% of the part's
    height at full sway, so the long back hair swings further than the bangs.
    `hair_back` is a mesh part for this; it still hangs from `headDeformer`
    with no cylinder bend.
  - `@ikijs/mcp`: `list_standard_parameters` lists the new parameter and spells
    out AngleZ's sign convention.

### Patch Changes

- d09ec76: Add `keywords` and widen the npm descriptions.

  All four packages shipped with no `keywords` at all — the field npm search ranks
  on — so none of them was reachable by the words people actually type. The root
  manifest had a good keyword list but it is `private: true` and never reaches the
  registry.

  The descriptions leaned on `.iki`, a name nobody is searching for yet, so each
  now also says what the thing is in terms that are searched: 2D puppet models,
  Live2D-style rigs, VTuber avatar animation, MCP for AI agents.

  Metadata only — no code, no API and no `.iki` contract change.

## 0.1.0

### Minor Changes

- 11a5b64: Add atlas + UV-rect textures: optional `textures` on the model and `texture` { index, uv } on parts (back-compat, no IKI_FORMAT_VERSION bump); the engine's `load()` is now async, samples atlas sub-rects with `color` as a tint multiplier, and resolves to an `IkiLoadResult` reporting any textures that failed to load (failed parts are skipped; the rest still render).
- de09cbd: Auto-rig now generates hair-sway secondary motion. `@ikijs/format` adds a `StandardParameter.HairSwayX` id (a physics-OUTPUT sway driver). `@ikijs/editor`'s `generateIkiFromLayerSet` now emits, when a `hair_front` layer is present, a `HairSwayX` parameter, a rotate + translateX sway binding on the front-hair part, and one `IkiPhysics` rig that lags `ParamAngleX` onto `HairSwayX` — so every auto-rigged / MCP-generated / skill-built character with front hair sways on head turn out of the box (no manual rigging). `@ikijs/mcp`'s `list_standard_parameters` now advertises `HairSwayX` (annotated as physics-output). No-hair models are unchanged (no extra param, no physics). Additive — no `IKI_FORMAT_VERSION` bump.
- da7ad77: Add per-side brow expression: BrowLeftY/RightY (raise/lower) and BrowLeftAngle/RightAngle (tilt) standard parameters in @ikijs/format, emitted as translateY + rotate bindings and declared parameters by the @ikijs/editor auto-rig, and surfaced by the @ikijs/mcp `list_standard_parameters` tool.
- 2eae3fc: Reject a `canvas.width`/`canvas.height` of zero or below. Only finiteness was checked, so meaningless extents validated cleanly and then produced silently wrong output rather than an error: one zero dimension renders the model at the wrong scale (the fit `Math.min` absorbs the infinity), both zero renders nothing, and negative extents mirror the whole character.

  **Schema tightening.** This rejects models an earlier build accepted. `IKI_FORMAT_VERSION` stays at 1: before 1.0 the v1 schema may still tighten without a bump, and such changes are called out here instead.

- fddc7af: Add clip masks to the `.iki` schema: `IkiPart.clip = { masks: string[] }`. A part is rendered only inside the (union of the) alpha coverage of the referenced mask parts — e.g. an iris clipped to the eye sclera so it never spills past the eye at extreme gaze. The validator enforces reference integrity (each mask id exists, no self-clip, no duplicate refs, mask must carry a `mesh`, masks are flat with no nesting) and now also rejects duplicate part ids so clip references resolve unambiguously. Additive, non-breaking — no `IKI_FORMAT_VERSION` bump (v1 is still pre-release).
- 7def749: Rotation deformer + pivot + parent hierarchy (#4a): @ikijs/format adds matrix-only IkiDeformer types (deformers field on model, deformer binding on parts) with validated acyclic hierarchy; @ikijs/engine composes deformer world matrices into the per-part transform chain about a pivot. Additive and optional — existing color/texture-quad models stay valid. Warp mesh, keyform, and per-vertex UV deformation deferred to #4b.
- 0a910df: Editor physics-rig authoring. `@ikijs/format` now rejects duplicate physics rig ids in `parseIkiModel` (consistent with the existing parameter- and part-id uniqueness checks) so id-keyed tooling can rely on unique rig ids — an additive validation tightening, no `IKI_FORMAT_VERSION` bump. `@ikijs/editor` adds a `findPhysicsRig` accessor and three invertible commands — `AddPhysicsRig`, `DeletePhysicsRig`, `SetPhysicsRig` — for CRUD + tuning of `model.physics` spring-mass-damper rigs (deep-cloning the nested `input`/`output`, validating each edit through `parseIkiModel`, forbidding rename, and keeping the `physics` key absent when empty). These back a new model-level "Physics Rigs" panel in the editor app.
- d25f9bb: Multi-segment hair-chain secondary motion + gravity. `@ikijs/format` adds an optional `model.physicsChains` (`IkiPhysicsChain[]`): each chain anchors to a matrix deformer and carries `gravity { angle, strength }` plus ordered `segments[]`, where every segment emits a per-segment rotation output param (θ as displacement-from-rest, in degrees) — validated with path-qualified `IkiFormatError` and cross-checked against the flat `physics[]` rigs (shared id/output uniqueness + output-as-input feedback, plus an implicit anchor-deformer feedback check). `@ikijs/engine` adds a new host-agnostic `HairChainMotion` peer driver (sibling of `PhysicsMotion`; `player.ts` untouched): an angular pendulum chain where each segment is a spring toward rest plus a world-down gravity torque, integrated with the same fixed 1/60 s semi-implicit-Euler discipline + finiteness guards, so a strand bends at its joints and hangs toward world-vertical regardless of head turn. The driver self-computes its anchor's world rotation via `resolveDeformerWorlds`, so hosts only call `update(now)`. Additive — no `IKI_FORMAT_VERSION` bump. A chain follows its anchor's matrix transform only (it does not ride a warp's foreshorten — gravity hair hangs in world space).
- 3441699: Add spring-mass-damper secondary motion. `@ikijs/format` gains an optional, additive `IkiPhysics` rig schema on `IkiModel.physics` — a 1D spring (`input`/`output` parameter refs + `mass`/`stiffness`/`damping`) validated with path-qualified `IkiFormatError` (declared input/output ids, `input !== output`, no duplicate output, no output-as-input feedback, `mass > 0`/`stiffness > 0`/`damping >= 0`). `@ikijs/engine` gains a new `PhysicsMotion` host-agnostic driver — the physics peer of `IdleMotion`: it reads an input parameter, signed-normalizes it around its default × `weight`, integrates a lagging spring with semi-implicit Euler on a fixed 1/60s sub-step accumulator (clamped dt + catch-up cap), and writes `outputDefault + position × scale` onto the output parameter so it lags and overshoots (hair/accessory sway). Spring constants are seconds-based. This is an additive `.iki` change with NO `IKI_FORMAT_VERSION` bump (pre-release v1); playground/example changes are not part of this changeset.
- 279928d: Pin down which side `Left`/`Right` name in `StandardParameter`. They are the CHARACTER's own side, not the viewer's — matching Live2D, whose ids these deliberately echo — so the character's left eye/brow is the part at POSITIVE x (screen right). The frame was never stated, and the two producers in this repo had already diverged: auto-rig treats `*_L` role layers as the character's left, while both hand-authored sample models bound `EyeOpenLeft` to their screen-left eye. A host winking one eye therefore closed the opposite eye depending on where the model came from.
- f9f5dfa: Warp deformer / group warp (#4c): @ikijs/format adds an `IkiDeformer` discriminated union (`IkiMatrixDeformer` | `IkiWarpDeformer`) with `IkiWarpGrid`/`IkiGridKeyform`/`IkiGridWarp`; a part referencing a `kind:"warp"` deformer must carry a `mesh` (path-qualified validation). @ikijs/engine resolves each warp deformer's deformed control grid per frame (parent matrix affine + single-parameter grid keyforms), binds child mesh vertices to the rest grid, and renders them by bilinear-sampling the deformed grid into the dynamic VBO, bypassing the affine deformer chain. Additive — `kind` omitted means `"matrix"`, so existing #4a/#4b/texture-quad models stay valid (no version bump, pre-release). Bezier/bicubic patches, multi-parameter grid blends, nested warp deformers, and matrix-under-warp are deferred.
- e2f4a89: Warp mesh + per-vertex UV + single-parameter keyform interpolation (#4b): @ikijs/format adds optional `IkiMesh`/`IkiKeyform`/`IkiWarp` types and part `mesh`/`warps` fields (`warps` requires `mesh`) with path-qualified validation; @ikijs/engine renders mesh parts via `drawElements` with per-vertex `a_uv` and applies CPU single-parameter keyform delta interpolation into a dynamic VBO each frame. Additive — existing color/texture-quad and #4a deformer models stay valid and continue through the preserved implicit-quad draw behavior / UV formula (the shared shader gains a mesh branch; the quad branch's output is preserved). 2D parameter grid, multi-parameter warp, and SLERP/non-linear interpolation are deferred.
- 008df01: 2D parameter-grid warp (joint AngleX×AngleY) — second driver via parameter-space bilinear blend (warp2d field).

### Patch Changes

- c5714cf: Ship `LICENSE` inside each package. Every package declared `"license": "MIT"`, but npm only picks up a package-ROOT licence file and does not follow a symlink, so the repo-root `LICENSE` never reached any tarball — the published artifacts named a licence they did not carry. The pre-publish check now gates on it alongside the README.
