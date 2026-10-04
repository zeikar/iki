# Auto-rig design

`generateIkiFromLayerSet` (`src/auto-rig/`) turns role-named layers into a
rigged `.iki`. This note is the model behind it; the code comments say why
each constant is what it is.

| Module         | Job                                                                                 |
| -------------- | ----------------------------------------------------------------------------------- |
| `types.ts`     | the public shapes: `LayerInput`, `TurnTargets`, `TurnSolveReport`, …                |
| `profile.ts`   | the rig's default values (our own, picked by eye) and the per-character style knobs |
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

## The model: the default rig

The rig follows a 2D head rig's usual rules. A turn is parallax, not a
reshaped face: the face plate translates, the features in front of it lead it
by their depth (the nose most), the chin leads it too, the front hair rides
the face, the back hair drifts a little the other way, and the neck and the
torso stay where they are. A nod is the same parallax vertically; a roll turns
the head about the chin. `profile.ts` derives how far each region moves at the
extremes of each head parameter from a short list of our own values,
`PROFILE_VALUES`. Lengths are in the head unit `hh` = the eye row → the chin
tip at rest, and every curve is linear in its angle on each side of rest, so
the keyforms at 0 and ±30 carry it exactly and a turn and a nod add.

**How the values were picked.** By eye, on two of our own characters (Bob, the
playground hero, and a long-haired one), in 2026-10. Each value's candidates
were round numbers on a coarse grid; one value changed at a time from a middle
set, rendered at the turn, nod, tilt and expression extremes, and the
candidates were compared with their columns shuffled — by a fresh agent that
was told nothing about them, and by us. The picked set was then compared
blind against the previous defaults, and one refinement round (the nose's
depth and the eyes' foreshortening) beat both.

| Value        | Rule                                                                                                                | Picked |
| ------------ | ------------------------------------------------------------------------------------------------------------------- | ------ |
| `slide`      | AngleX ±30: the face plate translates this far, hh                                                                  | 0.12   |
| `lead`       | a feature on the face (an eye, a brow, the mouth, the chin tip) leads the plate by this, hh                         | 0.10   |
| `noseDepth`  | the nose leads it this many times `lead`                                                                            | 2      |
| `hairFollow` | the front hair rides the face at this share of its slide                                                            | 1      |
| `fore`       | the far eye and the far ear narrow to 1 − fore, the near eye widens to 1 + fore / 2, each eye's lead with its width | 0.2    |
| `backShare`  | the back hair takes this share of the plate's motion: against it on the turn, with it on the nod                    | 0.1    |
| `earFar`     | the far ear's outer edge moves this share of the slide (the near ear rides the head)                                | 0.5    |
| `nodDown`    | AngleY −30: the plate's top drops this far, hh                                                                      | 0.18   |
| `nodUp`      | AngleY +30: the plate rises this far, whole, hh                                                                     | 0.10   |
| `nodLead`    | a feature leads the plate's nod at mid-face by this either way, hh; the nose `noseDepth` times it                   | 0.06   |
| `chinShare`  | looking down, the chin drops this share of the plate's top                                                          | 0.75   |
| `rollDeg`    | AngleZ ±30 rolls the head this many degrees about the chin                                                          | 14     |
| `gaze`       | the iris travels this many iris widths sideways, half as far up and down                                            | 0.2    |
| `blink`      | the upper lid comes down this share of the eye's height                                                             | 0.6    |
| `mouthOpen`  | a single mouth drawing opens to this height over its rest width                                                     | 0.8    |
| `mouthWiden` | the mouth widens to this much of its width open                                                                     | 1.2    |
| `brow`       | a brow raises and lowers this far, hh                                                                               | 0.15   |
| `breath`     | a breath lifts the shoulders this far, hh, and the head two thirds of it                                            | 0.03   |
| `sway`       | a hair tip travels this far at full sway (±20), hh                                                                  | 0.08   |

The plate keeps its width on the turn, the mouth stays level and the eyes keep
their height on the nod: those had candidates of their own, which read no
better.

**A turn is parallax, not a reshaped face.** At AngleX ±30, along the turn
(far = the side the face turns toward):

| Region               | Moves (hh)                                                                                                                                                                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| face plate           | 0.12                                                                                                                                                                            | translates; its width holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| chin tip             | 0.22                                                                                                                                                                            | leads the plate from the mouth row down (smoothstep)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| eyes far / near      | 0.21 / 0.23                                                                                                                                                                     | each foreshortened about its own centre: 0.8 / 1.1 of its width                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| brows far / near     | 0.21 / 0.23                                                                                                                                                                     | at the eyes' depth                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| nose                 | 0.32                                                                                                                                                                            | its tip swings a further 6° to the far side about the bridge top                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| mouth                | 0.22                                                                                                                                                                            | at the eyes' depth, level, its width held                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ears                 | far 0.5× the plate at its outer edge; near 1× at its widest reach                                                                                                               | behind the face: the far one narrows about its outer edge to 0.8 of its width (1 − fore) where the head leaves it room (less where it does not, never wider), its root sliding under the cheek but never further than the head moves there; the near one's root rides the head, so it widens a little rather than sliding out from behind it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| front hair           | 1 × the plate over the face; 0 at the outline it draws, more on each row where the back hair paints behind that edge through every turn and nod, up to its follow over the face | eased evenly between the eyes' outer corners and the outline; over the far eye, on the eye's rows, as far as that eye's corner goes; its crown rides with the cap as far as back hair is painted behind its edges and gaps through every turn and nod (never where the face lies behind a gap), no crown row further than the one under it; elsewhere it eases into the back hair's turn toward its top. On its cap (its rows above the far eye's), the turn — alone or with the nod and the roll — never puts the outer edge further outside the back hair painted behind it than the nod alone puts it. Where the nod alone keeps it inside, the edge never leaves the back hair. The nod's own motion is the cap slide's. A cap row whose back hair at rest leaves its edge's own pixel bare draws the outline itself and is not bound (in a cell it shares with a blended row it eases toward the back hair's motion). |
| back hair            | −0.012                                                                                                                                                                          | a slight counter-drift: the head moves in front of it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| neck (under the jaw) | 0                                                                                                                                                                               | the chin slides over it; the chin's shade on it slides with the chin (see below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| torso                | 0                                                                                                                                                                               | AngleX leaves it where it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

A nod (AngleY ±30, screen-down at −30 / up at +30) moves the plate's top
0.18 / 0.10 and the chin 0.135 / 0.10 (the face shortens a little looking
down). The features lead the plate's nod at mid-face (0.1575 looking down,
0.10 up) by `nodLead`, the nose by `noseDepth` times it: the eyes, the brows
and the mouth 0.2175 / 0.16, the nose 0.2775 / 0.22, the eyes keeping their
height. The front hair nods with the plate's top (`hairFollow` × it,
0.18 / 0.10) and its cap's top 0.18 / 0.05 (half the plate's rise looking up),
the back hair 0.018 / 0.01; the neck not at all. The front hair's crown eases
from its nod at the plate's top to the cap top's at the hair's top. Looking
up, the cap's top rises over its own background and uncovers nothing. Looking
down it slides by one value for the whole cap, so the cap stays rigid: the
largest, up to 0.18, at which no crown column bares more than 0.01 hh of the
rows the back hair leaves empty at its own nod beyond what the back hair's own
0.018 bares there — read off the hair layers' `rowRuns`, with each column's
top dropping as the mesh renders it. Without `rowRuns` it slides 0.018.
AngleZ ±30 rolls the head 14° about the chin.

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
- **The neck island** runs from the neck's cut edge up under the jaw by 0.35 hh
  (what the chin uncovers as it slides: half again its full-turn slide, to the
  next 0.05). Above the jaw line its rows show the
  drawing just under the cut — 0.04 hh under it below the chin, thinning to a
  pixel at the neck's outline — rather than the chin painted there: under the
  chin that is the neck below the shade band the head carries; past the band's
  end, whatever shade the neck keeps under the jaw. It is drawn first, so the head slides over it; its vertices
  take no part in the nod, undo the head's roll (within about a pixel
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
  ears sit behind the face, so the far one lags its slide: its outer edge
  moves `earFar` (0.5) of it, and the ear narrows evenly about that edge to
  1 − `fore` (0.8) of its width at a full turn, where the head leaves it
  room. So the root moves
  further, toward the head's slide, but never past the head's own motion on
  the line under the ear, and its tuck never past the head's motion over it,
  so it stays covered; where the head leaves less room, the ear narrows less,
  never wider than drawn. The outer edge keeps its 0.5 everywhere: where a
  fitted turn would narrow the head (a plate without hair) so far that it
  moved less than that edge on that line, the turn solve limits the
  narrowing (reported as clamped) — on the row where that binds, the ear
  keeps its width — so the ear never widens. The near ear's root — what lies inside that line —
  moves as the head moves it there, and the ear eases evenly out to the
  plate's slide at its widest reach: it rides the head rather than sliding
  out from under it, so its tuck never shows. Both nod with the face. A column of the head island
  that lies wholly outside the head collapses and fans no cells.

The face layer carries a neck when, below its widest row, the plate settles
onto a narrow plateau that runs on for at least 12 % of its height. A plate without
one is all head island: a face drawn without a neck, its neck drawn on the torso
(which never turns), slides whole over the torso's neck, with no jaw cut, chin-shade
band or hidden rows.

The plate, the blush and both hair layers carry their own AngleX and AngleY
keyforms (per vertex, under `headDeformer`); each feature family rides its own
small warp grid, baked from its field at `AngleX, AngleY ∈ {−30, 0, 30}`:

| Family (grid)      | Parts                                                                 |
| ------------------ | --------------------------------------------------------------------- |
| `eyeWarp_L/R`      | `eye_*`, `iris_*`, `pupil_*`, `highlight_*`, `lash_lower_*`, `lash_*` |
| `browWarp_L/R`     | `brow_*`                                                              |
| `noseWarp`         | `nose`                                                                |
| `mouthWarp`        | `mouth`, `mouth_open`                                                 |
| — (own keyforms)   | `face`, `blush_*`, `hair_front`, `hair_back`                          |
| — (`bodyDeformer`) | `body`: breath only                                                   |

## Style knobs and the fit

`options.style` tunes a character from the profile. The recommended range
after each knob is the span our candidates rendered without a defect on our
own characters (at its top end, `turn` and `featureLead` start to crowd the
far eye against the head's edge on some art); the knob itself accepts more:

| Knob            | Default | What it scales                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn`          | 1       | the whole turn — plate, features, hair, the eyes' foreshortening, the far ear's narrowing (recommended 0.7–1.3); ignored when `turnTargets.eyeShift` is given, which fits it instead                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `featureLead`   | 1       | the features' lead over the plate (recommended 0.6–1.4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `hairFollow`    | 1       | the front hair's share of the plate's turn (recommended 1–1.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `outlineFollow` | 0       | the front hair's outer edge's share of the turn, where it draws the head's outline (recommended 0: the back hair holds the outline); more on each row where the back hair paints behind that edge through every turn and nod, up to the front hair's follow there (`hairFollow`; over the far eye's rows, as far as that eye's corner goes). On its cap (its rows above the far eye's), the turn — alone or with the nod and the roll — never puts the outer edge further outside the back hair painted behind it than the nod alone puts it. Where the nod alone keeps it inside, the edge never leaves the back hair. The nod's own motion is the cap slide's. A cap row whose back hair at rest leaves its edge's own pixel bare draws the outline itself and is not bound (in a cell it shares with a blended row it eases toward the back hair's motion). |
| `blink`         | 0.6     | how far the upper lid comes down, over the eye's height (recommended 0.5–0.7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `sway`          | 1       | the hair sway amplitude (recommended 0.5–1.5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

`options.turnTargets` are the cues `measure_turn_reference` reads off a front
and a turned image. With none, the profile itself renders and the report says
what the cues then read. A given cue is fitted by the one knob it reads:

- `eyeShift` (the eye pair's slide against the head's silhouette, over its
  half-width) by the turn's amount, up to 3× the profile's — past that, or
  past the art's room, it is clamped;
- `farEyeRatio` (far/near eye width, over the same at rest) by the eyes'
  foreshortening — the profile's 0.8 / 1.1 is 0.73;
- `silhouetteRatio` by the hair layers' width at full turn (0.8–1.2), or the
  plate's when no hair draws the silhouette — a plate with ear islands
  narrowed only as far as the far ear allows (below), past which it is
  clamped;
- `noseShift` / `mouthShift` by that feature's own shift (no slower than the
  plate under it, no further than its room).

A cue out of its knob's reach is refused (`TurnTargetError`, naming the
attainable range), except `eyeShift`, and a `silhouetteRatio` past the far
ear's room, which are clamped. `DEFAULT_TURN_TARGETS` is the profile's turn
in the cues' units for a head whose silhouette at the eye row is back hair
about 1 hh wide: 0.23 / 0.73 / 1. The eye cue subtracts
the silhouette's own shift, so a head whose side locks draw its silhouette —
and ride the face, as they should — reads a smaller eyeShift
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
  (a profile shift past that is cut, and listed in `clamped`);
- on every row of the ear islands, the head moves at least as far on the far
  ear's line as that ear's outer edge (0.5 of the plate's slide), or its
  tucked strip would show: without hair, a fitted `silhouetteRatio` narrows
  the plate only that far (the rest is cut, and listed in `clamped`).

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
  coming down `blink` (0.6) of the eye's height (its clip region closes, so
  the iris is cut away, never squashed); the lash comes down onto the crease
  and flattens over the seam, its middle sagging further than its ends so the
  drawn arch does not close into a smile. A lower lash — the lower lid's line
  and lashes, drawn over the iris — folds onto the same crease with the white,
  so it never parts from the white's lower edge and closes into the seam.
- **Gaze** — iris, pupil (and half as far, a highlight) translate 0.2 of the
  iris's width sideways and 0.1 up or down, clipped to the white; they sit
  under the eye grid, so the turn carries them.
- **Brows** — raise/lower 0.15 hh and tilt (±15°) per side, raw-symmetric.
- **Mouth** — MouthForm lifts the corners and widens a little; with
  `mouth_open`, MouthOpen fades the closed lips out (twice, so they are gone
  by the time the open drawing is half grown) while the open drawing grows out
  of its top lip, both widening to 1.2×; without it, the closed mouth opens
  down to 0.8 of its width and widens to 1.2×.
- **Roll** — `headDeformer` rolls 14° at AngleZ ±30 about the
  chin; the neck island undoes it. Long hair gives back 35 % of the roll toward
  its ends (hanging); hair that ends above the chin (a fringe) rolls with the
  head. Keyed at AngleZ 0 and ±30.
- **Hair sway** — with `hair_front`, two springs (`AngleX → HairSwayX`,
  `AngleZ → HairSwayZ`) drive root-pinned swings of both hair layers, their
  ends travelling 0.08 hh at full sway (±20), growing down the layer as
  `t^1.4`. A spring settles on its target, so a held turn keeps the hair a
  quarter swung toward it (a held roll, 40 %).
- **Breath** — the shoulders (and the neck) lift 0.03 hh, the head 0.02 hh.

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
  measure them) holds the front hair's outer edge on every row and eases its
  crown to the back hair's turn, as if no back hair painted behind it.
- The cap's outline rides the face only where the back hair reaches past the
  front hair's edge by the cap's motion relative to it — the follow plus the
  back hair's drift, about 0.16 hh, and on the crown's rows up to
  (1 − w + w′) times that, w and w′ the crown's blend at a vertex row and at
  the one under it (1.3× where the blend climbs 0.31 between rows) — on every
  row it passes over on the nod. Where it reaches less, the cap follows less:
  a local cut out toward the edge, then a blend toward the back hair's
  motion.
- The cap's bound covers the cap only. Below it the front hair keeps today's
  motion, so the lock over the far eye goes as far as that eye's corner and
  the turn solve's far-iris bound is untouched; a side lock there can still
  step past a back hair that barely reaches past it.
- A bound cap row (its back hair at rest paints the pixel just inside its
  edge) that passes over back rows not holding that edge on the nod, or that
  rises above the back hair's top looking up, moves with the back hair on
  the turn — the nod alone already shows its edge outside — the bangs over
  the face on it included, and so does every crown row above it. A cap row
  whose back hair at rest leaves that pixel bare draws the outline itself
  and is not bound (in a cell it shares with a blended row it eases toward
  the back hair's motion).
- A cap row that the local cut cannot bring inside its back hair blends
  toward the back hair's motion, the bangs over the face on it included.
- The hair sway springs move the two hair layers by different amounts, which
  nothing bounds.
- A back hair that falls short of the cap's top near the crown's peak, where
  the crown takes little of the bangs' own nod — at a parting dip, say —
  holds the whole cap's top near the back hair's own 0.018 looking down,
  since one column binds the one slide. The full 0.18 needs a back hair
  drawn up past the front hair's top.
- The lock over the far eye is kept as far over its outer corner as drawn,
  not clear of it: on the hero the lash's tip is under the lock at rest. The
  report reads the iris's painted span, not what a lock covers of it, so a
  render measures a slightly smaller farEyeRatio than the report.
- The nod is linear from 0 to each extreme; so is the turn.
