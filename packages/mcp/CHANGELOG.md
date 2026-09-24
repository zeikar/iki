# @ikijs/mcp

## 0.9.0

### Minor Changes

- 75dae0c: Every model rigged from this release turns its mouth differently, and its eyes
  too wherever `strandEdges` is passed; already-rigged models are untouched.

  The mouth now slides across the face by its solved depth but foreshortens as
  the face does at its own rest position (≈ cos 30° on the face axis, since it
  sits centred there), and tilts up to 5° near end down at full turn — a style
  prior read off the 3/4 reference, since `measure_turn_reference` reads no
  mouth.

  A new option, `generateIkiFromLayerSet`'s `options.strandEdges` (type
  `IrisStrand`), gives each side's iris span and the bangs' side strand as real
  pixel edges on the iris row. When present, the turn keeps the far iris from
  sliding any further under that strand than it is painted — best effort, never
  a refusal: the fit prefers radii where some eye depth holds the bound, and
  where none does (including a fringe spanning the face, `runFace: null`) the
  rig is still built with the eyes' depth at 0. The new
  `TurnSolveReport.strandOverlap` (`StrandOverlap = { deg, px, hh, restPx, held }`)
  reports, per side, how much of the far iris the bangs cover at its worst stop
  in px and head half-widths, next to the painted coverage at rest, and whether
  the bound held. The option is always validated when passed, but has no effect
  on the rig without a `nose` layer — only the turn solve reads it.

  A CALLER `eyeShift` past the room the art leaves the far eye — the face
  plate's edge, or now the strand — is CLAMPED and listed in `clamped`, exactly
  like a defaulted one, where an earlier 0.x release refused it with
  `TurnTargetError`: THIS CHANGES WHICH MEASURED TARGETS RIG. Still refused: a
  caller `eyeShift` below the slide the face's own turn already gives the eyes,
  every other field (`farEyeRatio`, `silhouetteRatio`, `noseShift`,
  `mouthShift`, `headHalfWidth`), and `resolveTurnTargets`'s own range checks. A
  caller shift also no longer steers which radius the far/near ratio is fitted
  at — the radius is fitted across the same radii a defaulted shift allows, and
  the shift is cut to that radius's own room only where it has to be.

  Follow-on: the derived nose and mouth shares follow the lower achieved eye
  shift, and a refitted radius moves the bangs' lead. Unchanged:
  `TurnSolveReport`'s existing fields, `DEFAULT_TURN_TARGETS`, and the rest,
  nod, tilt, blink, mouth-open and sway renders.

  On the playground hero (before → after): the report reads eyeShift 0.22
  unclamped → 0.180 clamped (`clamped: ["eyeShift"]`) on a 360.99 → 351.40 px
  radius; a −30° render reads farEyeRatio / eyeShift / silhouetteRatio 0.591 /
  −0.210 / 1.000 → 0.658 / −0.176 / 1.002, and a +30° render 0.658 / +0.209 /
  1.000 → 0.640 / +0.168 / 1.000 (declared, not a regression: whole-pixel
  rounding, the turned far/near iris is 48/74 px on both sides, and the rest
  widths differ by 1 px that a wisp hides). The far iris's coverage moves from
  all hair covering 20.6% / 10.1% of it at −30° / +30° to the strand alone
  covering 0.15% / 0%; thin wisps still cross the iris edge, covering 8.4% /
  3.3% counting all hair. The mouth at −30° now spans ×0.853 of its rest width
  (was ×0.76) and tilts 3.6° near end down measured against its own rest line
  (5.0° at +30°; was −1.1°). The model's size moves from 1 274 307 to
  1 276 713 bytes. Rest, tilt, blink, mouth-open, sway and nod renders are
  pixel-identical.

  `auto_rig_from_layers` now measures each iris's opaque span and the bangs run
  it would slide under on the iris's own row, hands them to the generator as
  `strandEdges`, and returns them in the result. A bangs-covered iris is measured,
  not dropped — except that a `hair_front` run narrower than half of that iris's
  painted width on the row is treated as hair detail and skipped — a
  thin wisp crossing the iris on the turn is intended, not the strand meant to
  hold it clear — and the run taken is the next wide one. Its `turn` report now
  carries `strandOverlap` through, and a passed `eyeShift` past the art's room
  comes back clamped in `turn.clamped` instead of `INVALID`.

### Patch Changes

- Updated dependencies [75dae0c]
  - @ikijs/editor@0.7.0

## 0.8.1

### Patch Changes

- 3ea8080: Every model rigged from this release on turns differently: the head no longer
  turns on one grid. The face plate and each feature family ride a warp deformer
  of their own under `headDeformer` — `faceWarp` keeps its id and carries the
  plate alone, and the features get `eyeWarp_L/R`, `mouthWarp`, `noseWarp`,
  `browWarp_L/R` and `blushWarp_L/R` — every one of them baked from the same head
  surface at its own grid's resolution, so each part bends where it actually is
  instead of on the chords of a lattice sized for the whole head. Already-rigged
  models are untouched; they change only when they are rigged again.

  Each family's solved depth is grid geometry now rather than an `AngleX`
  translate on its parts (`bodyDeformer`'s is the model's only turn binding
  left), and the solve reads every cue — the eye pair's shift, the far eye's
  foreshortening, the silhouette — through the very grid and mesh those parts
  render with, so `onTurnSolved` reports the landings the engine will compute
  rather than those of a surface the parts only approximately sit on.
  `hair_front` comes off the shared grid entirely: it rides the head on its own
  per-vertex hold, lead and nod warps.

  Three renders move with the carrier, all of them declared. The nod is the same
  cylinder, sampled where each part is instead of on a six-row grid's chords, so
  the nod RENDER MOVES by that grid's chord error — on the playground hero ≈ 4–5
  px at the bangs' crown and tips and ≈ 2 px at the plate's top and chin rows.
  The far eye's rendered width ratio moves by about one pixel of iris for the
  same reason, the per-vertex eye grid replacing the shared grid's chord: the
  hero's -30° render reads farEyeRatio 0.591 where it read 0.579, toward the 0.67
  the reference measures rather than away from it. And bang tips swayed past the
  old shared grid's edge are no longer clamped flat, because the bangs bind to no
  grid at all now.

  A rig with no `nose` layer has no feature slide to fit and so no solve behind
  its cylinder; it falls back to a radius read off the turn lattice, and that
  lattice is the group grids' own reach now rather than the union of every turn
  layer's extent. The bangs no longer widen it, so a nose-less layer set turns on
  a tighter cylinder than 0.5 gave it.

  The new optional `LayerInput.rowHalfWidths` — one entry per crop row, half that
  row's opaque span in canvas px — gives the FACE plate a radius that varies by
  row and a small swing at the chin, so a jaw narrower than the cheekbones turns
  in rather than sweeping around the cylinder the eyes turn on; absent, the plate
  turns on the one constant radius it always did. `@ikijs/mcp` measures it: for
  the face layer only, `auto_rig_from_layers` hands the generator the per-row
  opaque half-widths it already decodes. Its schema, its arguments and its result
  are unchanged, and it inherits the editor's new turn.

  What stays: `TurnSolveReport` and `onTurnSolved` keep their shape,
  `DEFAULT_TURN_TARGETS` its values, `hair_back` static through the turn, and the
  tilt, the blink, the mouth and the rest-pose sway render as they did. On the
  playground hero the report reads eyeShift 0.2200 / farEyeRatio 0.670 /
  silhouetteRatio 1.000 on a 361 px radius — the eye shift reaching the default
  target now instead of clamping just under it — and a render of that rig at -30°
  measures farEyeRatio 0.591, eyeShift -0.210 and the silhouette holding at
  1.000, with the near jaw in and the chin ≈ 17–18 px toward the near side over a
  cranium that does not move. The extra grids cost bytes: the hero's model goes
  1.09 MB → 1.27 MB.

- Updated dependencies [3ea8080]
  - @ikijs/editor@0.6.0

## 0.8.0

### Minor Changes

- e8e7e95: New `measure_turn_reference` tool: measures how far a head turns between two
  images of the same character — one facing front, one turned — and reports it as
  three ratios, so a rigged turn can be compared against a reference turn (or an
  earlier rig) without registering the images. The pair must already share the
  same scale and framing: crop and position cancel, but scale does not, and a
  yaw never changes iris height, so a pair whose mean iris heights differ by more
  than 10% is refused rather than measured as if it were a turn. `farEyeRatio` is the
  turned far/near iris width over that same ratio at rest, `eyeShift` is how far
  the eye pair slides across the head in units of the FRONT head half-width
  (negative = toward the image's left), and `silhouetteRatio` is the head
  half-width turned over front; the raw per-image numbers come back alongside
  them, and `debugDir` writes an overlay per image with the iris boxes and head
  edges drawn. The irises are found through a colour window (violet by default,
  overridable through `iris`), and the head silhouette through one of two
  foreground rules picked per image: alpha alone for an engine render, a
  colour-keyed backdrop for opaque reference art.

  `auto_rig_from_layers` now takes those numbers. An optional `turnTargets`
  (`eyeShift`, `farEyeRatio`, `silhouetteRatio`, and the usually-derived
  `noseShift`/`mouthShift`) fits the rig's head turn to a measured reference, and
  the head half-width those shifts are fractions of is measured off the layers
  themselves — their opaque union at the eye row, under the same alpha rule and
  row band `measure_turn_reference` spans a render with, so the rig's own rest
  render measures that span back. The result carries that `headHalfWidth` and a
  `turn` report (`radius`, `holdBase`, `depths`, `achieved`, `clamped`) of what
  the solve settled on, plus a `headHalfWidthApplied` flag: a layer set whose head
  is not wider than its own face plate (a hairless one, say), or whose art is
  translucent below the opaque-union threshold (so `headHalfWidth` itself comes
  back absent), measures a head the generator will not take, so the plate stands
  in for it and a rig still comes out — the defaults always produce a model. When
  `headHalfWidth` is applied, the result also carries `headEdges`: every layer
  with an opaque pixel in that same eye-row band, per side, each with its own
  rest x there, passed to the generator's own `options.headEdges` so it can land
  each candidate through its OWN part's deformation (the bangs, the back hair, a
  face-plate or body edge move very differently on the turn) and take the
  outermost result, not just whichever one drew furthest out at rest. An omitted
  target falls back to a
  default that is clamped to what the layer set can do — `turn.clamped` names the
  ones that were — while a target the caller passed and the layer set cannot reach
  comes back as `INVALID: …` naming the field and the attainable range.

### Patch Changes

- Updated dependencies [2941ff6]
- Updated dependencies [fa07593]
  - @ikijs/editor@0.5.0

## 0.7.0

### Minor Changes

- 46fe55f: The nose is a part like the eyes and the mouth: `compose_layers_from_parts`
  places an optional `nose.png` from the parts dir (default centre between the
  eyes and above the mouth, 40 px wide, tunable through `layout.nose`) and no
  longer cuts a nose out of `face.png`. A parts dir without one composes as
  before and reports `nose` under `skipped`; `measure_layers` now warns that
  without a nose layer nothing on the face slides on the head turn. The face
  part should therefore be drawn without a nose.

## 0.6.0

### Minor Changes

- 496d4cb: `compose_layers_from_parts` cuts the nose out of the face into its own
  `nose.png` layer: within the gap between the eyes, from the eye line down to
  the mouth, every pixel that is not the face's skin colour (line art and
  shadow, judged row by row so shading across the face is not ink) moves to the
  nose layer and the face gets skin filled in behind it, so the two composite
  back to the original drawing at rest. A cut that would take a large share of
  the window, or one holding half-transparent pixels, is declined and the face
  stays whole. `auto_rig_from_layers`
  keys the new feature depth parallax on that layer — the nose leads the head
  turn, the mouth and eyes follow at their own depths — which a nose painted into
  the face plate cannot do. A face with no drawn nose composes as before and
  reports `nose` under `skipped`; a stale `nose.png` from an earlier compose is
  removed then, as for a skipped optional role.

### Patch Changes

- Updated dependencies [a92c107]
  - @ikijs/editor@0.4.0

## 0.5.0

### Minor Changes

- 73047b9: `compose_layers_from_parts` accepts a per-role `h` alongside `cx`/`cy`/`w`.

  Omitting it keeps the part's own aspect ratio, which is what every role wants until one does not. A generated eyewhite comes back flatter than its reference often enough to matter, and until now the only lever was the geometry report's advice to regenerate it taller — advice that cost three billed generations in one real run and still landed short, because the image model satisfies "taller" by tilting the almond rather than opening the eye. Stretching a flat white lens by 15% is invisible, free, and lands every time.

  The flat-sclera warning now names the `h` to set and on which two roles, since a sclera and its lash share one frame and the blink fold tears if only one of them moves.

### Patch Changes

- 6ec5a90: Stop two geometry warnings from prescribing the wrong fix.

  `measure_layers` flagged a lash as out of sync with its sclera whenever the lash's ink was asymmetric inside the frame it shares with the white — a flick that runs one way costs a pixel or two of centre drift while the layout entry is perfectly in sync, so the warning named a retune that could not be made. The centre tolerance now scales with the eye width; the top-edge check, which is the edge the blink fold actually rides, stays strict.

  An opaque canvas edge was always reported as "the art is cut off — regenerate with empty margin", but a part whose own source has margin can still be clipped by where the layout puts it, and regenerating reproduces that exactly. The report already measures what separates the cases well enough to act: an edge with margin left on that side is the drawing's own doing and is worth a regeneration, while an edge sitting flush is worth moving inward and remeasuring first, since that costs nothing and settles it.

## 0.4.0

### Minor Changes

- 3957b2f: Add two MCP tools ported from scripts (`compose.cjs`, `measure.cjs`) that shipped in the Claude Code plugin's character-generation skill. `compose_layers_from_parts` composes a directory of generated part PNGs into canvas-aligned, role-named PNG layers ready for `auto_rig_from_layers`, with a per-role `layout` override standing in for hand-editing the script, and returns the same geometry report inline. `measure_layers` re-runs that report standalone over an already-composed layers directory.

## 0.3.1

### Patch Changes

- Updated dependencies [b21b048]
- Updated dependencies [28049af]
- Updated dependencies [c6825c4]
  - @ikijs/editor@0.3.0

## 0.3.0

### Minor Changes

- 130825d: `auto_rig_from_layers` takes an optional `quantizeColors` (2..256) that
  palette-quantizes the embedded atlas PNG. Flat-shaded character art keeps its
  look at 256 colours while the model drops to roughly a quarter of its lossless
  size — the hero demo went from 3.5MB to 0.9MB — which is what makes a generated
  model shippable on a page. Omitted, the atlas is lossless as before.

### Patch Changes

- Updated dependencies [8b32275]
  - @ikijs/editor@0.2.1

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
    (no face-warp cylinder) and bends on the turn through its own part warp.
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
