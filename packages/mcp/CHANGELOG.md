# @ikijs/mcp

## 0.2.0

### Minor Changes

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

- Updated dependencies [d09ec76]
- Updated dependencies [f16b7c1]
- Updated dependencies [fe37018]
- Updated dependencies [cda1b78]
- Updated dependencies [99e4d4c]
- Updated dependencies [5cbf157]
- Updated dependencies [588962e]
- Updated dependencies [64617a7]
- Updated dependencies [48a1f5c]
  - @ikijs/format@0.2.0
  - @ikijs/editor@0.2.0

## 0.1.0

### Minor Changes

- f8e2030: Add an `auto_rig_from_layers` MCP tool: an agent passes role-named PNG file paths (face, eye_L/eye_R, mouth required; iris/brow/hair/lash optional) and gets back a renderable, validated `.iki` written to disk. The tool decodes, alpha-bboxes, crops, and atlases the layers in Node (via a new `sharp` dependency confined to `@ikijs/mcp`), reusing the pure `@ikijs/editor` model/atlas math (`generateIkiFromLayerSet`, `packAtlas`, `uvRectFor`, `EditorDocument.applyAtlas`) so the browser and Node paths stay in sync. The atlas is embedded as a base64 `data:image/png` texture and the model is `parseIkiModel`-validated before writing; the result returns the output path + summary stats rather than inlining the multi-MB model. No `.iki` schema change (no `IKI_FORMAT_VERSION` bump).
- de09cbd: Auto-rig now generates hair-sway secondary motion. `@ikijs/format` adds a `StandardParameter.HairSwayX` id (a physics-OUTPUT sway driver). `@ikijs/editor`'s `generateIkiFromLayerSet` now emits, when a `hair_front` layer is present, a `HairSwayX` parameter, a rotate + translateX sway binding on the front-hair part, and one `IkiPhysics` rig that lags `ParamAngleX` onto `HairSwayX` — so every auto-rigged / MCP-generated / skill-built character with front hair sways on head turn out of the box (no manual rigging). `@ikijs/mcp`'s `list_standard_parameters` now advertises `HairSwayX` (annotated as physics-output). No-hair models are unchanged (no extra param, no physics). Additive — no `IKI_FORMAT_VERSION` bump.
- da7ad77: Add per-side brow expression: BrowLeftY/RightY (raise/lower) and BrowLeftAngle/RightAngle (tilt) standard parameters in @ikijs/format, emitted as translateY + rotate bindings and declared parameters by the @ikijs/editor auto-rig, and surfaced by the @ikijs/mcp `list_standard_parameters` tool.
- 29914ab: Add @ikijs/mcp: stdio MCP server with validate/describe/list tools.

### Patch Changes

- b03198b: Keep esbuild metafiles out of the published tarball. The build now emits `dist/metafile-*.json` so the pre-publish check can prove `@ikijs/format` stays external rather than being inlined into each dependent (a second copy would break `instanceof IkiFormatError` across package boundaries), but that is build introspection: it carries no value for a consumer and leaks local paths.
- 3701485: The MCP server reported a hardcoded `version: "0.0.0"` in its `serverInfo`, which every MCP client shows in its server listing — so a published `@ikijs/mcp@0.1.0` would have introduced itself as 0.0.0, and drifted further with each release. The version is now baked from `package.json` at build time, and since the release script builds after the version bump, the published artifact always reports its own version.
- 2eae3fc: `detectAlphaBbox` now delegates to the shared scan in `@ikijs/editor` instead of re-implementing it, keeping this package's `AutoRigInputError` for an empty layer. Behavior is unchanged.

  Also documents why input paths are deliberately NOT confined to the working directory while output paths are: a stray write destroys data, a read only surfaces a file the agent named and the user can already open, and confining reads would break the documented character-generation flow, which composes its layers in a scratch directory. Adds direct tests for the path-resolution rejection branches, which were the least-covered code in the package.

- c5714cf: Ship `LICENSE` inside each package. Every package declared `"license": "MIT"`, but npm only picks up a package-ROOT licence file and does not follow a symlink, so the repo-root `LICENSE` never reached any tarball — the published artifacts named a licence they did not carry. The pre-publish check now gates on it alongside the README.
- Updated dependencies [11a5b64]
- Updated dependencies [79e384c]
- Updated dependencies [de09cbd]
- Updated dependencies [43047ea]
- Updated dependencies [da7ad77]
- Updated dependencies [2eae3fc]
- Updated dependencies [4e51f08]
- Updated dependencies [fddc7af]
- Updated dependencies [279928d]
- Updated dependencies [7def749]
- Updated dependencies [6025534]
- Updated dependencies [f7fa92f]
- Updated dependencies [87a38f4]
- Updated dependencies [09197f2]
- Updated dependencies [6c85def]
- Updated dependencies [c717bb2]
- Updated dependencies [0c23219]
- Updated dependencies [0542d48]
- Updated dependencies [9489848]
- Updated dependencies [0a910df]
- Updated dependencies [88bf46b]
- Updated dependencies [87a38f4]
- Updated dependencies [b03198b]
- Updated dependencies [d25f9bb]
- Updated dependencies [3441699]
- Updated dependencies [c5714cf]
- Updated dependencies [279928d]
- Updated dependencies [f9f5dfa]
- Updated dependencies [e2f4a89]
- Updated dependencies [008df01]
  - @ikijs/format@0.1.0
  - @ikijs/editor@0.1.0
