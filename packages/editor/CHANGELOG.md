# @ikijs/editor

## 0.2.1

### Patch Changes

- 8b32275: Keep the bangs' sway inside the face-warp grid. `hair_front`'s vertices are
  swayed and parallax-shifted before they bind to the grid, and past its edge
  they clamp to the edge column, flattening the tips into a line on a wide
  fringe or a hard turn. The swing is now capped so one hair spring at its peak
  stays inside; layouts with normal headroom are unchanged. The head-turn bakes
  also take their cylinder radius from the grid's reach about the axis rather
  than its outer columns, so the no-fold guarantee no longer assumes a grid
  symmetric about the face.

## 0.2.0

### Minor Changes

- f16b7c1: Auto-rigged models can now nod. `generateIkiFromLayerSet` declares
  `ParamAngleY` and drives `faceWarp` with one 2D grid warp over AngleX × AngleY
  (the new exported `bakeHeadTurnGridWarp2DCentered`), so the face foreshortens
  vertically as the head pitches; `headDeformer` gains a symmetric `AngleY`
  `translateY`, and `hair_back` an `AngleY` `translateY` that keeps its crown
  tucked under the bent front hair. The AngleY = 0 row of the 2D bake is exactly
  the old 1D turn bake, so the head turn is unchanged, and the rest pose renders
  identically.

  The nod is deliberately gentler than the turn (`NOD_BEND` = 0.5): the face-warp
  grid reaches the hair crown, where a full 30° bend dropped the bangs ~140px and
  exposed the rigid back hair above them as a second silhouette.

  `bindingsForRole` takes a new `parallaxUnitY` option alongside `parallaxUnit`.

  Because a warp deformer carries either `warps` or `warp2d`, auto-rigged models
  now emit `warp2d` and no `warps`. Anything that reads `faceWarp.warps[0]`
  directly — the example editor's grid-keyform drag authoring and its grid
  overlay — sees no 1D warp on these models until it learns `warp2d`; the engine
  plays them unchanged.

- fe37018: Add a `mouth_open` role so a rigged mouth can actually open.

  With only a closed-mouth drawing, mouth-open was `scaleY` 0..3 on art that is
  typically a ~15px-tall line. Stretching it four times over produces a blurred
  band, not an open mouth — fine for a portrait, useless for lip-sync.

  A layer set that also supplies `mouth_open` now cross-fades the two drawings on
  `ParamMouthOpenY` through the `opacity` channel, which the format and engine
  already supported, and the closed mouth is no longer stretched. `MouthForm`
  still drives `scaleX` on whichever drawing is showing.

  Layer sets without a `mouth_open` layer keep the stretch and produce exactly the
  model they did before.

- cda1b78: Add a `body` role to the auto-rigger for a character's torso.

  Every existing role hangs from either `faceWarp` or `headDeformer`, and
  `headDeformer` rotates the whole head about the neck pivot — so there was no way
  to rig shoulders that stay put while the head turns, and a generated character
  read as a floating head. `body` is the one role attached to no deformer at all:
  it is emitted as a static quad with `part.deformer` omitted, drawn over
  `hair_back` and under `face`.

  `RoleSpec.deformer` widens to `"faceWarp" | "headDeformer" | "none"`.
  `auto_rig_from_layers` accepts `body.png` in its layer set as a result.

  A layer set without a `body` produces exactly the model it did before.

- 99e4d4c: Auto-rig the head turn with depth parallax. `hair_front` and `hair_back` no
  longer track the face plane exactly: each gets an `AngleX` `translateX` sized by
  its depth from the head cylinder's axis, so the bangs lead the face and the back
  hair follows it at a distance. The back hair also bends on the turn through its
  own part warp (`bakeHairBackTurnWarp`, exported): the near side tucks behind the
  face at a far flatter radius than the face's, and the far side bulges out as
  the hair volume hidden behind it swings into view.
  Without these both layers were glued flat to the face and a turn read as a
  cutout sliding sideways.

  Adds the exported `headTurnParallaxUnit(gridHalfWidth)`, the shared unit both the
  warp bake and the hair bindings derive from. `bindingsForRole` takes it through a
  new `parallaxUnit` option and emits no parallax without it, so existing callers
  are unaffected.

  Also fixes a latent bug this surfaced: parts with no mesh dropped their bindings
  during assembly. Only `hair_back` and `body` take that path and neither had any
  until now, so no released model changed.

- 5cbf157: Pin the cylinder axis in the head-turn warp bake.

  Rotating a cylinder slides its whole visible surface sideways by
  `RADIUS * sin(theta)` on top of foreshortening it — 170px on a 430px-wide face
  at 30 degrees. That bulk slide is what pushed a generated head off its
  shoulders, dragged the neck with it, and left the back hair trailing as a
  separate mass; the foreshortening on its own is what reads as a turn.

  The bake now subtracts the axis column's own displacement, so the centre of the
  face holds still and only the differential remains. Offsets stay monotonic, so
  no grid cell folds. Deliberate lateral head motion is unaffected — it lives on
  `headDeformer`'s `translateX` binding, where it can be tuned on its own.

  Generated models turn less far sideways than before. Shrinking `RADIUS` was the
  other candidate and is a trap: below the grid's half-width the outer columns
  saturate at `asin(±1)` and cross over their neighbours, inverting the mesh.

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
    (no face-warp cylinder) and bends on the turn through its own part warp.
  - `@ikijs/mcp`: `list_standard_parameters` lists the new parameter and spells
    out AngleZ's sign convention.

- 48a1f5c: Auto-rigged models can now tilt their head. `generateIkiFromLayerSet` declares
  `ParamAngleZ` (−30..30) and gives `headDeformer` a `rotate` binding of one
  degree per degree about the neck pivot. Positive AngleZ rolls the head
  clockwise on screen — the top of the head toward the viewer's right — which is
  Live2D's convention (its sample motions give AngleZ the sign of AngleX 214 times
  out of 222) and the same sense as the rig's existing lean into a turn, so a
  host's head-tracking roll maps onto AngleZ 1:1. The two rotations sum, as two
  rolls about one pivot should.

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

- 588962e: Fully close the sclera clip during blinks when a matching separate lash layer is present, preventing a visible strip of iris beneath the closed eyelid. Eyes without separate lashes retain their existing closed-eye line.
- Updated dependencies [d09ec76]
- Updated dependencies [64617a7]
  - @ikijs/format@0.2.0

## 0.1.0

### Minor Changes

- 79e384c: Auto-rig: front hair (`hair_front`) now rides the face warp (as a mesh part) so it follows the head-turn curvature together with the face, instead of staying a rigid blob that detaches on turn. Its bbox joins the faceWarp grid union so the grid covers it. `hair_back` stays rigid (per-layer depth parallax is a later slice).
- de09cbd: Auto-rig now generates hair-sway secondary motion. `@ikijs/format` adds a `StandardParameter.HairSwayX` id (a physics-OUTPUT sway driver). `@ikijs/editor`'s `generateIkiFromLayerSet` now emits, when a `hair_front` layer is present, a `HairSwayX` parameter, a rotate + translateX sway binding on the front-hair part, and one `IkiPhysics` rig that lags `ParamAngleX` onto `HairSwayX` — so every auto-rigged / MCP-generated / skill-built character with front hair sways on head turn out of the box (no manual rigging). `@ikijs/mcp`'s `list_standard_parameters` now advertises `HairSwayX` (annotated as physics-output). No-hair models are unchanged (no extra param, no physics). Additive — no `IKI_FORMAT_VERSION` bump.
- 43047ea: Auto-rig: replace the scaleY-collapse blink with a Live2D-style eyelid FOLD. The eye-white (`eye_L`/`eye_R`) now carries two `EyeOpen` `IkiWarp` keyforms (via a new `bakeEyelidFoldWarp`) that collapse it toward a crease as the eye shuts, and `iris_/pupil_/highlight_` parts now clip to the white instead of blinking. As the white folds closed its clip region shuts, so the round iris is **cut away** (not vertically squashed) — the eyeball no longer deforms. An OPTIONAL `lash_L`/`lash_R` role (the upper lashes, drawn above the iris) folds down to the same crease to cover the closed seam cleanly. No `IKI_FORMAT_VERSION` bump (`IkiWarp` and clip are already v1).
- da7ad77: Add per-side brow expression: BrowLeftY/RightY (raise/lower) and BrowLeftAngle/RightAngle (tilt) standard parameters in @ikijs/format, emitted as translateY + rotate bindings and declared parameters by the @ikijs/editor auto-rig, and surfaced by the @ikijs/mcp `list_standard_parameters` tool.
- 279928d: Deformer commands no longer strand a document in a state `toIkiModel()` refuses.
  - `validateDeformerDelete` takes a new `physicsChains` argument (positional, before `deformerId`) and rejects deleting a deformer a chain still anchors to. The format validator rejects a dangling `anchorDeformer`, so such a delete previously succeeded and only failed later, at export.
  - `SetDeformerBindings` validates a narrow synthetic candidate before mutating, the way `SetPartBindings` and `SetPartMesh` already do, so an undeclared parameter, a non-finite endpoint, or a non-matrix channel is rejected up front with the deformer's own id in the message. The candidate is deliberately narrow rather than a clone of the whole document: a host editor UI may hold a non-finite value in an unrelated part while a numeric field is being edited, and validating that would refuse the edit and report it against the wrong object.
  - A binding or reparent that feeds a physics chain's output into its own anchor stays an export-time error in `toIkiModel()`. Detecting it needs the whole deformer hierarchy, which cannot be checked without also validating the unrelated parts above.

  `DeleteDeformer.invert` no longer fabricates a missing `deformers` array; `apply` only captures after `validateDeformerDelete` passes, so the defensive `??=` could only ever mask a broken undo stack.

- 6025534: Export `detectAlphaBbox` (plus `ALPHA_BBOX_THRESHOLD` and the `AlphaBbox` type): the alpha bounding-box scan every auto-rig ingestion path needs. It was implemented twice — once over canvas `ImageData` in this repo's browser editor app, once over a `sharp` buffer in `@ikijs/mcp`, with a comment on each asking the other to stay byte-identical by hand. The scan only needs indexable RGBA bytes, so both now call this and only the decode differs.
- f7fa92f: Atlas layout/UV helpers + non-undoable `applyAtlas` (roadmap 5b). Adds DOM-free `packAtlas`/`uvRectFor` + `AtlasSource`/`AtlasPlacement`/`AtlasLayout` types and `ATLAS_PADDING`/`UV_INSET_PX` constants, plus a non-undoable `EditorDocument.applyAtlas({ textures, partTextureAssignments })` method (validate-all-then-apply: replaces the texture table and sets/clears each part's `texture` atomically) with `AtlasAssignment`/`ApplyAtlasInput` types.
- 87a38f4: Add the auto-rig layer-set generator: `generateIkiFromLayerSet` turns a labelled set of canvas-sized layer descriptors (role + alpha bbox + crop dims) into a valid, standard-rigged `.iki` model — parts placed at their source positions with a head-turn warp, neck pivot, and per-role blink/gaze/mouth/breath bindings. Also exports the `parseLayerRoles` filename→role helper and the `LayerInput` type. The editor app consumes these to import a named PNG layer set into a rigged model (roadmap #6 first slice).
- 09197f2: Add `SetPartBindings` command (whole-array replace; validates written bindings against declared parameters via a narrow synthetic `parseIkiModel` candidate; absent-vs-empty key discipline), the pure `captureBindingEndpoint` capture-math helper (additive delta; multiplicative opacity ratio with a documented base-opacity-0 degenerate case), and non-undoable ephemeral transform setters (`setPartTransformEphemeral` / `setDeformerTransformEphemeral`) for a host editor's transient capture pose.
- 6c85def: Add undoable create/delete commands for parts and deformers (AddPart, AddDeformer, DeletePart, DeleteDeformer). Add commands validate the full candidate model through the format validator before mutating, so the working model stays parseable after every op. Includes default part/deformer factories and a deformer-delete structural validator. `EditorDocument` gains a non-undoable method to clear model-committed textures, consistent with the atlas layer.
- c717bb2: Warp-deformer grid keyform authoring helpers + command (roadmap 5d). Adds three DOM-free, grid-size-agnostic pure helpers — `interpolateGridOffsets` (clamp + linear interpolation of grid offsets between the bracketing keyforms at a parameter value), `computeGridOffsets` (derive offsets from a dragged-point array relative to its rest positions), and `upsertGridKeyform` (replace-or-insert a keyform at a parameter value, maintaining strictly ascending order) — plus the undoable `CaptureGridKeyform` command and `EditorDocument.findWarpDeformer`. `CaptureGridKeyform.apply` validates that `offsets.length === deformer.grid.points.length` (fail fast) and that the captured `value` is within the driving parameter's min/max range (fail fast). Format and engine are unchanged; no `IKI_FORMAT_VERSION` bump.
- 0c23219: Add the `createGridMesh` factory and `SetPartMesh` command (add / regenerate / remove a regular grid mesh on a part), unblocking warp-deformer attachment for from-scratch parts. `SetPartMesh` validates the new mesh against the format before mutating, keeps the `applyAtlas` base-UV side-table consistent across undo/redo, and fails fast (rather than silently invalidating warps) when removing or regenerating a mesh under authored per-vertex warps or a warp-deformer attachment.
- 0542d48: Matrix-deformer hierarchy authoring (roadmap 5e). Adds DOM-free, undoable commands to author the deformer rig numerically — `SetDeformerPivotX` / `SetDeformerPivotY` / `SetDeformerTransform` (whole-transform capture; an identity `{x,y}` base is created when editing a transform-less deformer, since `IkiDeformerTransform` requires finite `x`/`y`) / `SetDeformerBindings` (whole-array replace with deep-copy capture/invert) / `SetDeformerParent` / `SetPartDeformer`. Adds the `findMatrixDeformer` / `findDeformer` document accessors and the pure `validateDeformerReparent` / `validatePartAttach` helpers, which fail fast (path-qualified `Error`) on a self-reference, a cycle, a non-matrix parent, an undeclared id, or attaching a meshless part to a warp deformer — so a bad reparent never mutates the model or reaches `parseIkiModel`. Format and engine are unchanged; no `IKI_FORMAT_VERSION` bump.
- 9489848: `EditorDocument.applyAtlas` now textures MESH parts (roadmap 5c): for an assigned mesh part it remaps each per-vertex `mesh.uvs` into the part's atlas UV-rect (and sets `texture`), and restores the original UVs + clears `texture` when a part is untextured. The remap derives from a base-UV snapshot captured at construction, so re-texturing/repacking never compounds. The public `applyAtlas` input shape is unchanged (`{ partId, uv }`) — the mesh remap is internal; no new barrel export.
- 0a910df: Editor physics-rig authoring. `@ikijs/format` now rejects duplicate physics rig ids in `parseIkiModel` (consistent with the existing parameter- and part-id uniqueness checks) so id-keyed tooling can rely on unique rig ids — an additive validation tightening, no `IKI_FORMAT_VERSION` bump. `@ikijs/editor` adds a `findPhysicsRig` accessor and three invertible commands — `AddPhysicsRig`, `DeletePhysicsRig`, `SetPhysicsRig` — for CRUD + tuning of `model.physics` spring-mass-damper rigs (deep-cloning the nested `input`/`output`, validating each edit through `parseIkiModel`, forbidding rename, and keeping the `physics` key absent when empty). These back a new model-level "Physics Rigs" panel in the editor app.
- 88bf46b: Add the atomic `SetDeformerPivot` command for a canvas pivot gizmo: it sets a matrix deformer's pivot x/y in one step so a single canvas drag is a single undo step. `SetDeformerPivotX`/`SetDeformerPivotY` stay for single-axis numeric inputs.
- 87a38f4: Introduce `@ikijs/editor` (lean 5a editor foundation): a DOM-free editing core that depends only on `@ikijs/format`. Provides `EditorDocument` (wraps an `IkiModel`, structured-cloned on construction), invertible part-edit commands with an undo/redo stack (`SetPartColor`/`SetPartWidth`/`SetPartHeight`/`SetPartOrder`/`SetPartTransform`, capture-once prior values, RGBA tuple cloning, optional-channel delete-on-undo), and `toIkiModel()`/`serialize()` round-trip validation via `parseIkiModel` (path-qualified `IkiFormatError` propagates unchanged). No gizmos, mesh, atlas, or deformer authoring yet.

### Patch Changes

- 4e51f08: `DeletePart` and `SetPartMesh` now refuse to invalidate a part that is used as another part's clip mask (`clip.masks`): `DeletePart` won't delete the mask part, and `SetPartMesh` won't strip its mesh (masks must be mesh parts). Both mirror the existing texture-reference guard. Clip masks are the first part→part reference in the model contract; without these guards, deleting a mask part or removing its mesh would leave dangling references that fail `toIkiModel()` and break preview/export.
- b03198b: Keep esbuild metafiles out of the published tarball. The build now emits `dist/metafile-*.json` so the pre-publish check can prove `@ikijs/format` stays external rather than being inlined into each dependent (a second copy would break `instanceof IkiFormatError` across package boundaries), but that is build introspection: it carries no value for a consumer and leaks local paths.
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
