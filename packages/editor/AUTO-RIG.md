# Auto-rig design

`generateIkiFromLayerSet` (`src/auto-rig/`) turns role-named layers into a
rigged `.iki`. This note is the model behind it; the code comments say why
each constant is what it is.

| Module         | Job                                                                                 |
| -------------- | ----------------------------------------------------------------------------------- |
| `types.ts`     | the public shapes: `LayerInput`, `TurnTargets`, `TurnSolveReport`, …                |
| `profile.ts`   | the Live2D profile the rig reproduces, and the per-character style knobs            |
| `roles.ts`     | the role table (draw order, family) and `parseLayerRoles`                           |
| `layout.ts`    | boxes, rounding, grid meshes                                                        |
| `head.ts`      | the head's frame read off the layers: axis, eye row, chin, head unit, neck, jaw cut |
| `face-mesh.ts` | the face plate's mesh: a head island and, under the jaw, a neck island              |
| `fields.ts`    | one displacement field per family, off the profile                                  |
| `grid.ts`      | warp lattices, the AngleX × AngleY bake, and landing a point the engine's way       |
| `solve.ts`     | the profile in this head's pixels; fitting the cues; room, clamps, refusals; report |
| `context.ts`   | what the solve reads off the layers; the lander that reads a rig back as drawn      |
| `checks.ts`    | input checks: a malformed layer throws, a malformed turn option `TurnTargetError`   |
| `drivers.ts`   | everything but the turn: blink fold, gaze, brows, mouth, hair sway, roll hang       |
| `generate.ts`  | assembly: parts, meshes, deformers, parameters, physics                             |

## The model: a Live2D default rig

The defaults are measured, not designed: `profile.ts` holds how far each region
of a head moves at the extremes of each head parameter on the Cubism sample
models Haru, Hiyori, Mao and Natori. Each was posed one parameter at a time,
with idle motion, breath, blink, physics and expressions held at their
defaults; each region was measured on its own drawables, and the numbers are
medians over the four. Lengths are in the profile's head unit
`hh` = 1.017 × (eye row → chin tip) — 264.5 render px on the hero — and every
curve is linear in its angle on each side of rest, so the keyforms at 0 and
±30 carry it exactly and a turn and a nod add.

**A turn is parallax, not a reshaped face.** At AngleX ±30, along the turn
(far = the side the face turns toward):

| Region               | Moves (hh)                                                                                                                                                                        | Notes                                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| face plate           | 0.118                                                                                                                                                                             | translates; its width 0.985 on the eye and cheek rows, 0.96 at the jaw                                                                                                                        |
| chin tip             | 0.194                                                                                                                                                                             | leads the plate from the mouth row down (smoothstep)                                                                                                                                          |
| eyes far / near      | 0.192 / 0.230                                                                                                                                                                     | each foreshortened about its own centre: 0.85 / 1.085 of its width                                                                                                                            |
| brows far / near     | 0.213 / 0.243                                                                                                                                                                     |                                                                                                                                                                                               |
| nose                 | 0.301                                                                                                                                                                             | its tip swings a further 6° to the far side about the bridge top                                                                                                                              |
| mouth                | 0.213                                                                                                                                                                             | 0.975 of its width, far corner up 4.4°                                                                                                                                                        |
| ears                 | far 0.44× the plate; near 0.87× at its widest reach                                                                                                                               | behind the face: the far one slides under the cheek; the near one's root rides the head, so it widens a little rather than sliding out from behind it                                         |
| front hair           | 1.1 × the plate over the face; 0 at the outline it draws, more on each row where the back hair paints behind that edge at every angle of the turn, up to its follow over the face | eased evenly between the eyes' outer corners and the outline; over the far eye, on the eye's rows, as far as that eye's corner goes; its crown eases to the back hair's motion toward its top |
| back hair            | −0.027                                                                                                                                                                            | a slight counter-drift: the head moves in front of it                                                                                                                                         |
| neck (under the jaw) | 0                                                                                                                                                                                 | the chin slides over it; the chin's shade on it slides with the chin (see below)                                                                                                              |
| torso                | 0                                                                                                                                                                                 | AngleX leaves it where it is                                                                                                                                                                  |

A nod (AngleY ±30, screen-down at −30 / up at +30) moves the plate's top
0.178 / 0.081 and the chin 0.109 / 0.0875 (the face shortens a little looking
down), the eyes 0.202 / 0.167 (squashed to 0.96 / 0.994 of their height), the
brows 0.223 / 0.167, the nose 0.193 / 0.207, the mouth 0.177 / 0.172, the
front hair 0.189 / 0.110, the back hair 0.025 / 0.011; the neck not at all.
AngleZ ±30 rolls the head 10° about the chin.

## The plate, the neck and the ears

The neck comes one of two ways. Either the torso draws it, rising behind the
face, and the face is drawn without one, so the plate is all head (its ears
aside). Or the face layer paints it below the jaw, together with ears on its
sides. Left on the plate, a painted neck would turn with the head and drag across
the collar, and the ears would slide as if painted on the cheek. The plate's mesh is
therefore several islands of the same drawing, and the same part, drawn neck
first, then ears, then head:

- **The head island** covers the plate down to just under the jaw's outline.
  Across the neck that line is the jaw's measured stroke — `LayerInput.jawRows`,
  which the layer measurer reads off the face's pixels (going down each column
  from the plate's widest row, the last row of the first stroke darker than
  0.55 of the plate's median luminance) — lowered under the chin by 0.05 hh,
  so the dark band a chin casts on the neck goes with the chin rather than
  staying behind as a second jaw line. That band thins evenly to nothing
  short of the neck's outline: the cut draws its end the chin's slide at a
  full turn and 2 px inside the waist (it thins out four columns sooner,
  since the cut takes the lowest of three columns either side and is read
  between them), so at ±30 the end lands at least 2 px inside the outline.
  Carried on to the outline, a turn slid its end past the neck as an unlined
  wedge of neck over the top of the outline. The 2 px fringe margin still
  thins evenly to nothing at the outline itself (with no margin under the
  stroke there). The slide is the solved turn's, so the frame is built
  twice: the turn is solved on the first, the parts are built on the second,
  which differs from it only in this cut. Without a measured stroke the line
  is a V from where the jaw's outline meets the neck's sides down to the chin
  (estimated half the eye→mouth span under the mouth). Beside the neck it
  follows the plate's own outline. A column sits at the chin, at each jaw
  corner and, under a measured stroke, at each end of the band — none taking
  another's place — so the V runs through vertices.
- **The neck island** runs from the neck's cut edge up under the jaw by 0.3 hh
  (what the chin uncovers as it slides). Above the jaw line its rows show the
  drawing just under the cut — 0.04 hh under it below the chin, thinning to a
  pixel at the neck's outline — rather than the chin painted there: under the
  chin that is the neck below the shade band the head carries; past the band's
  end, whatever shade the neck keeps under the jaw. It is drawn first, so the head slides over it; its vertices
  take no part in the nod, undo the head's roll (within a fraction of a pixel
  between its keyed extremes), and rise with the shoulders on a breath. On the
  turn its outline and its base stay, but the shade under the chin slides
  sideways with the chin: from 0.2 of the neck's height under the chin up
  it moves whole, fading to nothing at its base, and across it moves most at
  the centre, nothing at the neck's outline — at most 0.45 of the neck's
  half-width, so the drawing between keeps more than half its width. Its rows
  are level, shared by every column (not slanted with the jaw's V, whose
  narrow cells the fade would fold).
- **The ear islands** exist where the plate's outline steps out by 3 % of its
  widest half-width within three rows and back in below, above the chin, at
  least a tenth of the eye→chin span apart. The head's own outline under an
  ear is the line between the rows just outside that band; the head island
  ends along it, and each ear island runs from 0.08 hh inside it (tucked
  under the head, so an ear opens no gap beside it) out past the ear. The
  ears lag the face's slide by the samples' parallax ratios. The far ear
  moves 0.44 of it, its tuck sliding deeper under the head. The near ear's
  root — what lies inside that line — moves as the head moves it there, and
  the ear eases evenly out to 0.87 of the slide at its widest reach: it
  widens a little rather than sliding out from under the head, so its tuck
  never shows. Both nod with the face. A column of the head island that lies
  wholly outside the head collapses and fans no cells.

The face layer carries a neck when, below its widest row, the plate settles
onto a narrow plateau that runs on for at least 12 % of its height. A plate without
one is all head island: a face drawn without a neck, its neck drawn on the torso
(which never turns), slides whole over the torso's neck, with no jaw cut, chin-shade
band or hidden rows.

The plate, the blush and both hair layers carry their own AngleX and AngleY
keyforms (per vertex, under `headDeformer`); each feature family rides its own
small warp grid, baked from its field at `AngleX, AngleY ∈ {−30, 0, 30}`:

| Family (grid)      | Parts                                                 |
| ------------------ | ----------------------------------------------------- |
| `eyeWarp_L/R`      | `eye_*`, `iris_*`, `pupil_*`, `highlight_*`, `lash_*` |
| `browWarp_L/R`     | `brow_*`                                              |
| `noseWarp`         | `nose`                                                |
| `mouthWarp`        | `mouth`, `mouth_open`                                 |
| — (own keyforms)   | `face`, `blush_*`, `hair_front`, `hair_back`          |
| — (`bodyDeformer`) | `body`: breath only                                   |

## Style knobs and the fit

`options.style` tunes a character from the profile, only where the samples
themselves disagree by more than their median (style, not construction):

| Knob            | Default | What it scales                                                                                                                                                                                                                                                                                                               |
| --------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn`          | 1       | the whole turn — plate, features, hair, the eyes' foreshortening (0–3; the samples' plate slides 0.05–0.25 hh); ignored when `turnTargets.eyeShift` is given, which fits it instead                                                                                                                                          |
| `featureLead`   | 1       | the features' lead over the plate (the nose leads it 2.2–4.4×)                                                                                                                                                                                                                                                               |
| `hairFollow`    | 1.1     | the front hair's share of the plate's turn (1.0–1.37)                                                                                                                                                                                                                                                                        |
| `outlineFollow` | 0       | the front hair's outer edge's share of the turn, where it draws the head's outline (the samples' back hair holds it); more on each row where the back hair paints behind that edge at every angle of the turn, up to the front hair's follow there (`hairFollow`; over the far eye's rows, as far as that eye's corner goes) |
| `blink`         | 0.58    | how far the upper lid comes down, over the eye's height (0.30–0.67)                                                                                                                                                                                                                                                          |
| `sway`          | 1       | the hair sway amplitude (0.02–0.36 hh at the extremes)                                                                                                                                                                                                                                                                       |

`options.turnTargets` are the cues `measure_turn_reference` reads off a front
and a turned image. With none, the profile itself renders and the report says
what the cues then read. A given cue is fitted by the one knob it reads:

- `eyeShift` (the eye pair's slide against the head's silhouette, over its
  half-width) by the turn's amount, up to 3× the profile's — past that, or
  past the art's room, it is clamped;
- `farEyeRatio` (far/near eye width, over the same at rest) by the eyes'
  foreshortening — the profile's 0.85 / 1.085 is 0.78;
- `silhouetteRatio` by the hair layers' width at full turn (0.8–1.2), or the
  plate's when no hair draws the silhouette;
- `noseShift` / `mouthShift` by that feature's own shift (no slower than the
  plate under it, no further than its room).

A cue out of its knob's reach is refused (`TurnTargetError`, naming the
attainable range), except `eyeShift`, which is clamped. `DEFAULT_TURN_TARGETS`
is the profile's turn in the cues' units for a head whose silhouette at the
eye row is back hair about 1 hh wide: 0.22 / 0.78 / 1. The eye cue subtracts
the silhouette's own shift, so a head whose side locks draw its silhouette —
and ride the face, as they should — reads a smaller eyeShift (the hero: 0.08)
for the same turn.

The room the turn is bounded by, the whole turn scaled down to fit it (with a
nose or without one):

- the far eye's far corner stays inside the plate's outline on its row —
  unless a side strand frames that eye, which then covers the outline there;
- the chin stays over a neck the face paints (its shift at most that neck's
  half-width), or the neck's hidden top would come out from under the jaw; a
  neck drawn on the torso bounds nothing (see Known limits);
- the far iris goes no deeper under its bangs' strand (`strandEdges`) than it
  is painted — best effort: a strand that leaves less than half the profile's
  turn is left to overlap, and `strandOverlap.held` is `false`;
- the nose and the mouth keep 5 % of their row's half-width inside the plate
  (a profile shift past that is cut, and listed in `clamped`).

The report is measured, not predicted: every cue is re-read the way the engine
draws it — each part's mesh vertices through its baked grid, or its own
keyforms, at the stop, then linearly across the mesh triangle the point sits
in (for the plate, the head island's). The shift cues are fractions of the
head a render spans at the eye row (the measured silhouette, or the plate's
painted edge there), as `measure_turn_reference` takes them. `holdBase` is the
measured head half-width (the plate's crop half-width standing in when none
was measured); `depths` each family's shift at ±30 as the depth a rotation
would need for it (`shift / sin 30°`), in `holdBase` units; `radius` the
curvature the plate would need to put the eyes that far in front of its edge.

## Everything else

- **Blink** — the eye white folds to zero height on a crease, its upper edge
  coming down `blink` (0.58) of the eye's height (its clip region closes, so
  the iris is cut away, never squashed); the lash comes down onto the crease
  and flattens over the seam, its middle sagging further than its ends so the
  drawn arch does not close into a smile.
- **Gaze** — iris, pupil (and half as far, a highlight) translate 0.17 of the
  iris's width sideways and 0.11 up or down, clipped to the white; they sit
  under the eye grid, so the turn carries them.
- **Brows** — raise/lower 0.089 hh and tilt (±15°) per side, raw-symmetric.
- **Mouth** — MouthForm lifts the corners and widens a little; with
  `mouth_open`, MouthOpen fades the closed lips out (twice, so they are gone
  by the time the open drawing is half grown) while the open drawing grows out
  of its top lip, both widening to 1.15×; without it, the closed mouth opens
  down to 0.77 of its width and widens to 1.15×.
- **Roll** — `headDeformer` rolls a third of AngleZ (10° at ±30) about the
  chin; the neck island undoes it. Long hair gives back 35 % of the roll toward
  its ends (hanging); hair that ends above the chin (a fringe) rolls with the
  head. Keyed at AngleZ 0 and ±30.
- **Hair sway** — with `hair_front`, two springs (`AngleX → HairSwayX`,
  `AngleZ → HairSwayZ`) drive root-pinned swings of both hair layers, their
  ends travelling 0.06 hh at full sway (±20), growing down the layer as
  `t^1.4`. A spring settles on its target, so a held turn keeps the hair a
  quarter swung toward it (a held roll, 40 %).
- **Breath** — the shoulders (and the neck) lift 0.025 hh, the head 0.016 hh.

## Known limits

- A face drawn without a neck whose chin tapers long and straight can read as
  a plateau, and the rig then holds the chin's tip still as a neck island. Nothing
  bounds the turn by a neck drawn on the torso either: the chin may slide past it,
  and only a render of the turned head shows whether its top stays hidden.
- An ear's island is cut along a chord under it, not along the drawn
  outline where the ear meets the cheek (which the alpha does not show). On
  the far side, where that outline runs outside the chord, it stays with the
  ear, so there the head's edge slides over the ear unlined.
- The chin's shade slides at most 0.45 of the neck's half-width (on the hero
  0.13 of the chin's 0.19 hh), and not on a nod (looking up uncovers the
  hidden top's shade instead). The cut follows a measured stroke only where
  the art has line work under the jaw; otherwise it is a V estimated from
  the outline. The band under the stroke goes with the chin only as far as
  the waist less the chin's full-turn slide: a cast shadow drawn past that
  stays on the neck, and shows under the jaw on the near side. Past the
  band's end the cut still runs a little under the stroke — the fringe
  margin, part thinned there, and the jaw's drop over the low filter's three
  columns — and at full turn that sliver crosses the outline: about 3 px
  deep where the jaw falls 0.56 px per column, under 5 px where it falls 0.9.
- On a row where no back hair paints behind the front hair's outer edge,
  holding the outline it draws squeezes the far side lock (to about 0.6 of
  its width at ±30 on the hero) and widens the near one; with
  `outlineFollow` at `hairFollow` the locks ride whole instead and the
  outline moves with the face.
- A layer set whose hair layers carry no `rowRuns` (a host that does not
  measure them) holds the front hair's outer edge on every row, as if no
  back hair painted behind it.
- The lock over the far eye is kept as far over its outer corner as drawn,
  not clear of it: on the hero the lash's tip is under the lock at rest. The
  report reads the iris's painted span, not what a lock covers of it, so a
  render measures a slightly smaller farEyeRatio (the hero: 0.775 against
  0.784).
- The nod is linear from 0 to each extreme, as on the samples; so is the turn.
