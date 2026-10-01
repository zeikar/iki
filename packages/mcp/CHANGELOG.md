# @ikijs/mcp

## 0.13.0

### Minor Changes

- ffe678a: `compose_layers_from_parts` composes a cheek blush pair, `blush_L` and `blush_R`, from one optional `blush.png` drawn as the screen-left blush (it is mirrored for `blush_L`; pass `mirrorParts: ["blush.png"]` if it was drawn facing the other way). Both are new `layout` keys, so the pair can be retuned per character. It draws over the face and under the nose, and a parts set without `blush.png` raises no warning.

  `compose_layers_from_parts` also drops a light mark drawn detached above the eye white, such as a double-eyelid crease, from the sclera, which is the iris's clip, so the iris no longer shows through it as a dashed line at half blink. Dark strokes there still count as lash ink, as before.

### Patch Changes

- Updated dependencies [ffe678a]
  - @ikijs/editor@0.10.1

## 0.12.1

### Patch Changes

- c8d0f83: The `measure_layers` "nose: missing" warning, the `compose_layers_from_parts` description and the README now describe the 0.12 rig: a layer set without a `nose` still turns its head on the Live2D profile — what it lacks is the nose leading the turn and the turn fit (`turnTargets` is inert, no `turn` report).

## 0.12.0

### Minor Changes

- 7a9b3c0: **Every model rigged from this release on turns, nods, rolls, blinks and
  sways differently, and models rigged earlier are untouched until they are
  rigged again.** The auto-rig (`generateIkiFromLayerSet`, and so
  `auto_rig_from_layers`) is rewritten to reproduce a Live2D default rig,
  measured on the Cubism sample models and described in
  [`packages/editor/AUTO-RIG.md`](packages/editor/AUTO-RIG.md). There is no
  `.iki` format change.

  What moves:
  - The parallax turn: the face plate translates, the chin and features lead
    it, the front hair rides the face and holds the outline it draws, and the
    back hair counter-drifts.
  - The face layer's neck and ears become islands: the neck stays, the chin's
    shade slides over it, and the ears lag.
  - AngleZ rolls the head about 10° around the chin.
  - `body` only breathes; it no longer takes AngleX.
  - Gaze, blink, mouth, brow, breath and sway amplitudes come from the profile.

  Model structure a host may notice: `faceWarp` and `blushWarp_L/R` are no
  longer emitted. The face, blush and both hair layers carry their own
  AngleX/AngleY keyforms under `headDeformer`. `eyeWarp_L/R`, `browWarp_L/R`,
  `noseWarp` and `mouthWarp` remain. Turn and nod keyforms sit at 0 and ±30
  only.

  API changes:
  - `DEFAULT_TURN_TARGETS.farEyeRatio` goes from 0.67 to 0.78. `eyeShift` 0.22
    and `silhouetteRatio` 1 are unchanged. With no `turnTargets`, the rig
    renders the profile, and the report says what the cues read.
  - A passed `eyeShift` is fitted by the turn's amount, up to 3×, so a small
    one is fitted rather than refused. The "every silhouetteRatio in
    [0.5, 1.5]" refusal is gone.
  - `clamped` names the turn (passed, or the profile's own) where the art's
    room cut it, and a profile `noseShift` / `mouthShift` past its room.
  - `strandEdges` without `hair_front` now throws `TurnTargetError`.
  - `TurnSolveReport.radius` and `depths` keep their fields, with new meanings
    documented on the types.

  Input changes (0.x, so no bump, but a call that worked before can now be
  refused):
  - Signed `eyeShift` / `noseShift` / `mouthShift` are still accepted, as
    before; the magnitude is used.
  - A face layer under 24 px is refused, naming the file.
  - An unknown `style` or `turnTargets` key is refused, and so is a `style` or
    `turnTargets` that is not a plain object. In `@ikijs/mcp`, `autoRigFromLayers`
    returns all of these, and a `turnTargets.headHalfWidth` (which the tool
    measures off the layers), as an `INVALID` result instead of dropping them or
    rigging on the defaults. Over MCP, the tool's input schema still rejects a
    non-object before the tool runs, which the SDK answers with an `isError`
    "Input validation error" result.
  - `parseLayerRoles` keeps its name normalisation; directory prefixes are
    still not accepted.

  New API:
  - `options.style` and the exported `RigStyle`: six knobs (`turn`,
    `featureLead`, `hairFollow`, `outlineFollow`, `blink`, `sway`) with
    defaults and ranges. A knob out of range throws `TurnTargetError` naming
    `style.<knob>`. `style.turn` is ignored under a caller `eyeShift`.
  - `LayerInput.jawRows`, measured by `createLayerSetMeasurer`.
  - `@ikijs/mcp`: the `style` input on `auto_rig_from_layers`, and the
    rewritten tool text. The result shape is unchanged.

  The playground hero was re-rigged as an example.

### Patch Changes

- Updated dependencies [7a9b3c0]
  - @ikijs/editor@0.10.0

## 0.11.3

### Patch Changes

- 1220ac5: `@ikijs/editor` now exports `createLayerSetMeasurer`, along with `RgbaLayer`,
  `LayerSetMeasurer` and `LayerSetMeasurement`, and the seven pixel rules it
  shares with `@ikijs/mcp`'s other tools — `ALPHA_OPAQUE`, `HEAD_BAND`,
  `SPECK_CORE_FRACTION`, `denseCoreOf`, `isSpeckCore`, `foregroundSpan` and
  `headHalfOf` — moved from `@ikijs/mcp`, where they lived beside the
  pre-rig measurement they were tuned for.

  `auto_rig_from_layers` now measures through it instead of its own inline
  steps, with unchanged results: the playground hero re-rigs byte-identical,
  and its turn report is unchanged. `measure-turn.ts` re-exports the moved
  rules, so `compose_layers_from_parts`, `measure_layers` and mcp's own tests
  keep importing them from the same place. This release raises mcp's
  `@ikijs/editor` dependency to `^0.9.0`.

  The editor example app's layer import now measures its layers the same
  way, through the same accumulator, so a model it builds and one
  `auto_rig_from_layers` builds from the same layers rig identically.

  No `.iki` format change.

- Updated dependencies [1220ac5]
  - @ikijs/editor@0.9.0

## 0.11.2

### Patch Changes

- ec2bec2: Models rigged from this release turn differently in two places; a model
  already rigged is untouched until it is rigged again.

  `mouthWarp` gains columns over the mouth drawings' own extent, capping each
  cell there at 32 px, whenever a cell was wider — its outer columns, tilt and
  width are unchanged. A cell 133.8 px wide let a mouth's chord miss the
  jaw-tapered turn surface it should sit on, drawing the mouth toward the near
  side; the hero's grid goes from 5×5 to 9×5 nodes (`describe_iki` now reports
  `gridX` 8 for it), its worst mouth-vertex miss on the turn falls from 5.29 to
  0.22 model px at ±30 and from 2.74 to 0.11 at ±15, and its far/near
  half-widths at ±30 go from 26.7/39.8 to 31.3/35.1 px (the surface's own
  31.45/34.98). Wherever the two mouth drawings share a
  centre x the turn cues are unchanged.

  With a face row profile — which every `auto_rig_from_layers` rig measures —
  bangs hanging below the face's widest row now hold as that row does, instead
  of reading their own (jaw-tapered) row. A side lock that follows the jaw
  below that row no longer creases there: the hero's crease at ±30 falls from
  ≈12° to 0.3°, and its below-chin slide moves from −35/+36 to −64/+64 render
  px at −30/+30. Hair below the chin or on the chest now follows the head as
  the widest row does, and a lock that hugs the jaw no longer rides it below
  the widest row (up to ≈12 px of drift at ±30 on a test fixture; nothing on
  the hero, whose locks keep ≥ 72 px of margin there). The hero's turn cues:
  eyeShift 0.1803 → 0.1829 (farEyeRatio 0.670 and silhouetteRatio 1.000
  unchanged), the solve's radius 351.40 → 352.03.

  No public API and no `.iki` format change.

  `@ikijs/mcp`'s `auto_rig_from_layers` rigs with both fixes, since this
  release raises its `@ikijs/editor` floor to `^0.8.1`.

- Updated dependencies [ec2bec2]
  - @ikijs/editor@0.8.1

## 0.11.1

### Patch Changes

- 2cc9fc4: `compose_layers_from_parts` now sizes and places a nose whose dense core is a
  speck — under a quarter of its trimmed part's width or height, such as a lone
  nostril mark — as a whole part, instead of blowing that speck up to
  `layout.nose.w`, and its inline report warns with that source-part verdict;
  `layout.nose`'s `w`/`h` then size the whole part, feather included. Its report also warns when the composed layer's own core is a speck of
  its crop even though the source part's was not. `measure_layers` flags a
  composed nose layer whose core is a speck of its crop — the layer
  `auto_rig_from_layers` acts on.

  `auto_rig_from_layers` hands the rig no such core: the crop stands in for the
  nose's turn landmark and tilt pivot, and `noseCore` is absent. The rig always
  succeeds. Noses whose core is not a speck — opaque line/dot noses, soft
  shaded noses — compose and rig exactly as in 0.11.0.

  The `turnTargets` description now states when a `silhouetteRatio` refusal
  offers no range: when no ratio in [0.5, 1.5] renders on the layer set, the
  refusal names the whole range rather than a narrower one, so leave the field
  out — a defaulted one clamps.

## 0.11.0

### Minor Changes

- a136de4: Every model rigged from this release with a `nose` layer turns its nose
  differently: at full turn the nose tilts 6° about its bridge top, tip toward
  the far side, and foreshortens as the face does at its own rest position — the
  mouth's rule since 0.7. Already-rigged models are untouched; they change only
  when they are rigged again.

  The optional `LayerInput.denseCore` — the tight box of the layer's pixels at
  alpha ≥ 128 — becomes the nose's landmark and pivot; the crop stands in when it is
  absent.

  Unchanged: `DEFAULT_TURN_TARGETS`, `TurnSolveReport`'s fields, the iris–strand
  bound, the mouth, and every render at AngleX 0.

  `compose_layers_from_parts` now sizes and places the nose by its dense core
  instead of its trimmed crop. `layout.nose.w`/`h` size the core (default 40 px
  wide), and `cx`/`cy` place its centre; with `cy` omitted, the tip lands 0.86 of
  the way from the eye row to the mouth. A LAYOUT TUNED AGAINST 0.10 MOVES ITS
  NOSE.

  `auto_rig_from_layers` hands the nose's dense core to the rig and reports it
  as `noseCore`. With `quantizeColors`, the nose lands on a second, lossless
  atlas page instead of the shared quantized one: the model carries two
  `textures`, and `atlasBytes` counts both. The nose's own lossless page adds a
  content-dependent amount to the model's size, since removing the nose from
  page 0 also changes how that page re-quantizes — on the playground hero the
  split model came to 1.28MB, about the same as the all-quantized 1.29MB and
  well under the 3.18MB lossless model. Because the 256-colour page is now
  chosen without the nose, the other parts' edge pixels can shift slightly
  against a 0.10 rig of the same layers.

  On the playground hero (before → after): the nose depth moves 0.1679 →
  0.1442, with `noseCore` measuring {x 530, y 549, w 39, h 63}; the tilt against
  the untilted rig reads −6.2° at AngleX −30 and +6.0° at +30; the nose's
  feather-ring rim metric reads 0.181 against a lossless render, where an
  all-quantized atlas reads 2.819; and the model grows from 1 276 713 to
  1 279 354 bytes for its second page. The turn report's other fields — radius
  351.397, holdBase 262, eye/mouth depths 0.0928/0.1363, achieved
  eyeShift/farEyeRatio/silhouetteRatio 0.1803/0.670/1.000, `clamped:
["eyeShift"]`, headEdges and strandEdges — and the eye and silhouette cues at
  ±30 are unchanged.

### Patch Changes

- Updated dependencies [a136de4]
  - @ikijs/editor@0.8.0

## 0.10.0

### Minor Changes

- 98fca40: `compose_layers_from_parts` takes a new optional `mirrorParts` — part files to
  flip left-right as they are read, e.g. `["eyewhite.png"]`. It flips the
  source, so every role cut from it flips together and an eye's sclera and lash
  stay in one frame. A part drawn facing the other way is now a free fix rather
  than a billed regeneration. An entry that is not a part file (a typo, or a role
  such as `eye_L`) is rejected as `mirrorParts[i]: unknown part …`.

  The composer reads `eyewhite.png` as the eye on the screen left (lash wing at
  the image's left end, lash-free tear duct at its right) and `brow.png` as the
  brow on the screen right (thick head at the image's left end). That was always
  the case; it is now documented in image terms, since "left eye" reads as the
  viewer's left or the character's.

  The geometry report (`measure_layers`, and inline in the compose result) gains
  a check: an eye whose lash, inside the frame it shares with the sclera, stops
  more than 2% of the eye width further short of the outer corner than of the
  nose side is reported as drawn facing the other way, naming
  `mirrorParts: ["eyewhite.png"]` as the fix. It reads the ends rather than the
  ink's centroid, so a long thin wing at the outer corner reads correctly. A
  layer set that passed before can now warn — one real run's three eyewhite
  variants all came back reversed, and composed as-is they trip it.

- e8e5952: The geometry report's lash drift check no longer flags a correctly composed
  eye, and now catches a drift it used to miss. It compared the lash's ink
  centre with the sclera's, within 3% of the eye width — but a lash stops short
  of the tear duct, so an eye drawn the right way sits 3-5% off centre and
  tripped it with a "Retune to match" nothing could act on. It now counts the
  lash's opaque pixels that land off the sclera: in sync there are none, since
  the sclera was recoloured from those very pixels, and on a real eye a 2 px
  shift, either way, moved more than 2% of them off — including a lash drifting
  in toward its bare tear duct, which stays inside the sclera's frame and which
  the centre check let through. The top-edge check stays, and still catches a
  lash scaled down inside its sclera with its aspect kept. The warning names
  only the fault that fired (`lash_L: N of its M opaque px lie off eye_L's
sclera`, or its top-edge offset) instead of always quoting the centre offset.

  A lash narrowed inside its sclera at the same height still lies on it and inks
  its top row, so no check over the layers can see it — `compose_layers_from_parts`
  now refuses the layout instead: `eye_L`/`lash_L` and `eye_R`/`lash_R` must land
  on the same frame once placed, and a pair that does not is rejected as
  `layout.lash_L places the lash at 120x86 (597,432), but layout.eye_L places its
sclera at 140x86 (587,432) — …`. It compares where the two land, not the values
  set, so an `h` equal to the one the aspect gives still composes. This rejects a
  layout an earlier 0.x composed with a drift warning — including an `h` set on
  the sclera alone that changes its height, which the docs already said to set on
  both.

  Every placement is now checked before any layer is written, so a refused
  compose — this frame mismatch, or a part placed entirely off the canvas —
  leaves `outDir` as the last compose left it instead of half overwritten.

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
