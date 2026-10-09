# Auto-rig design

`generateIkiFromLayerSet` (`src/auto-rig/`) turns role-named layers into a
rigged `.iki`. This note is the model behind it; the code comments say why
each constant is what it is.

| Module            | Job                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| `types.ts`        | the public shapes: `LayerInput`, `TurnTargets`, `TurnSolveReport`, …                                          |
| `profile.ts`      | the defaults (our own: the head's picked by eye, the body's provisional), style knobs                         |
| `roles.ts`        | the role table (draw order, family) and `parseLayerRoles`                                                     |
| `layout.ts`       | boxes, rounding, grid meshes                                                                                  |
| `head.ts`         | the head's frame read off the layers: axis, eye row, chin, head unit, neck, jaw cut                           |
| `face-mesh.ts`    | the face plate's mesh: a head island and, under the jaw, a neck island                                        |
| `body.ts`         | the body warp: the hips, a weight field planted under them, its six 1D grid warps                             |
| `arms.ts`         | the arms: shoulder and elbow off the runs; elbow cap, upper arm and forearm cut from one crop                 |
| `forearm-pose.ts` | the pose forearm: a second, raised forearm swapped in at the elbow, rocked about it                           |
| `mouth.ts`        | the folding mouth: the opening read off the lip set's alpha, the seam, the fold, the shared frame, the anchor |
| `fields.ts`       | one displacement field per family, off the profile                                                            |
| `grid.ts`         | warp lattices, the AngleX × AngleY bake, and landing a point the engine's way                                 |
| `solve.ts`        | the profile in this head's pixels; fitting the cues; room, clamps, refusals; report                           |
| `context.ts`      | what the solve reads off the layers; the lander that reads a rig back as drawn                                |
| `checks.ts`       | input checks: a malformed layer throws, a malformed turn option `TurnTargetError`                             |
| `drivers.ts`      | everything but the turn: blink fold, gaze, brows, mouth, hair sway, roll hang                                 |
| `animations.ts`   | the default expressions and motions, each described; filtered to the declared parameters                      |
| `generate.ts`     | assembly: parts, meshes, deformers, parameters, physics, expressions, motions                                 |

## The model: the default rig

The rig follows a 2D head rig's usual rules. A turn is parallax, not a
reshaped face: the face plate translates, the features in front of it lead it
by their depth (the nose most), the chin leads it too, the front hair rides
the face, the back hair drifts a little the other way, and the torso follows
the head only a little, the head hung from it (see The body). A nod is the
same parallax vertically; a roll turns the head about the chin. `profile.ts`
derives how far each region moves at the extremes of each head parameter from
a short list of our own values, `PROFILE_VALUES`. Lengths are in the head unit
`hh` = the eye row → the chin tip at rest, and every curve is linear in its
angle on each side of rest, so the keyforms at 0 and ±30 carry it exactly and
a turn and a nod add.

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
| `blushRest`  | at Cheek 0 the blush shows at this opacity, at Cheek 1 as drawn (picked with the expressions, below)                | 0.4    |

The plate keeps its width on the turn, the mouth stays level and the eyes keep
their height on the nod: those had candidates of their own, which read no
better.

**A turn is parallax, not a reshaped face.** At AngleX ±30, along the turn
(far = the side the face turns toward), each region moves this far over the
torso under the chin, which the body's follow carries a further 0.03 hh with
the head:

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
| torso                | 0.03 at the chest (`bodyFollowX` × BodyAngleX's slide)                                                                                                                          | the body warp's follow, easing to nothing at the hips: the legs stay planted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

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
(which turns only with the body's small follow), slides whole over the torso's
neck, with no jaw cut, chin-shade band or hidden rows.

The plate, the blush and both hair layers carry their own AngleX and AngleY
keyforms (per vertex, under `headDeformer`); each feature family rides its own
small warp grid, baked from its field at `AngleX, AngleY ∈ {−30, 0, 30}`:

| Family (grid)             | Parts                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `eyeWarp_L/R`             | `eye_*`, `iris_*`, `pupil_*`, `highlight_*`, `lash_lower_*`, `lash_*`                 |
| `browWarp_L/R`            | `brow_*`                                                                              |
| `noseWarp`                | `nose`                                                                                |
| `mouthWarp`               | `mouth`, `mouth_open`, `mouth_inner`, `lip_lower`, `lip_upper`                        |
| — (own keyforms)          | `face`, `blush_*`, `hair_front`, `hair_back`                                          |
| — (`bodyWarp`)            | `body`: breath, BodyAngleX/Y/Z, the follow                                            |
| — (`armDeformer_L/R`)     | `arm_*`: the upper arm, about the shoulder (`ParamArmL/R`)                            |
| — (`forearmDeformer_L/R`) | `forearm_*` and `elbow_*`: the forearm and its cap, about the elbow (`ParamElbowL/R`) |
| — (`armPoseDeformer_L/R`) | `forearm_pose_*`: the raised forearm, about A's elbow (`ParamArmPoseAngleL/R`)        |

## The body

With a `body` layer, the body rides one root warp, `bodyWarp` (`body.ts`). It
turns the upper body on BodyAngleX/Y/Z (±10), follows the head's turn
(AngleX) and tilt (AngleZ) a little, and breathes, while everything under the
hips stays planted. `headDeformer` hangs from it: a matrix deformer under a
warp rides the cell that holds its pivot rigidly (the engine's
`warpRigidFrame`), so the head moves and turns with the upper body but is
never sheared or narrowed by it.

**The bands.** Each of the warp's six 1D grid warps offsets a lattice point by
its row line's weight times one field. Its row lines run, top to bottom:

- band A, weight 1, from 6 px (`BODY_GRID_PAD`) above the highest of the
  body's top and the pivots down to `yFull`: 0.8 hh (`CHEST_DROP`) under the
  chin, or 6 px above the lowest pivot if that is lower;
- the ramp, weight smoothstep from the hips' line up to `yFull`, so the waist
  eases out of the hips and into the chest;
- the hips' line, weight 0, and one weight-0 cell down to 6 px under the lower
  of the hips and the body's bottom.

Every pivot lies above `yFull`, and the engine binds a point on a row line
into the cell below it, so each pivot's cell is all weight 1: it moves by one
affine map, and the head rides it rigidly. On a body too short for that,
`yFull` is the midpoint of the hips and the lowest pivot, a hundredth clear of
each (every line and pivot is on the 0.01 grid the model is written on). Hips
less than 0.02 px under the lowest pivot leave no line between them; a ramp
too short for the motion folds. At every combination of the six warps' stops,
and between them, each lattice cell must stay a convex quad turned as at rest
(each corner's triangle keeps a hundredth of its rest area), which keeps every
body mesh triangle from turning over. The rig refuses either layer with
`LayerGeometryError`, which `@ikijs/mcp` reports as `{ ok: false }`. The
body's mesh is cut on every lattice row line inside its box, the hips' line
and `yFull` among them, each gap split into rows at most 48 px tall, so no
triangle drags the legs along with the waist.

**The hips**, the weight-0 line, by the first rule that applies:

1. the leg split: the top edge of the first body row, 0.35–0.75 of the crop's
   height down, holding two or more opaque runs (`rowRuns`) each at least 0.1
   of the crop's width;
2. the cut: a body crop that reaches the canvas's last row, as a waist-cut
   bust does, is planted at its bottom edge;
3. otherwise, half the body's height under its top.

**The keyforms**, keyed at rest and at each extreme. Each offset is the one at
the + extreme on a weight-1 point p = (x, y); H is the body's centre x on the
hips' line, and the − extreme mirrors the shift and the angle (the narrowing
holds):

| Warp (in this order)       | Stops      | Offset at the + extreme                                                 |
| -------------------------- | ---------- | ----------------------------------------------------------------------- |
| `ParamBodyAngleX`          | −10, 0, 10 | x by `bodySlide`·hh − `bodyNarrow`·(x − H.x): slides, narrows about H.x |
| `ParamBodyAngleY`          | −10, 0, 10 | y by `bodyBow`·hh: + rises, − bows                                      |
| `ParamBodyAngleZ`          | −10, 0, 10 | a clockwise rotation about H by `bodyRoll`                              |
| `ParamAngleX` (the follow) | −30, 0, 30 | BodyAngleX's field at `bodyFollowX` of it                               |
| `ParamAngleZ` (the follow) | −30, 0, 30 | a clockwise rotation about H by β = `bodyFollowZ` × `bodyRoll` (1.2°)   |
| `ParamBreath`              | 0, 1       | y by `breath`·hh (0.03): the shoulders' breath                          |

**The head on the body.** The warp already moves the chin's cell, so the head
deformer's own bindings are what the body leaves:

- **Breath.** The cell lifts the chin 0.03 hh, so the head's own breath is
  (`breathHead` − `breathBody`)·hh, a 0.01 hh drop, and its net is still
  0.02 hh. The neck island's own (`breathBody` − `breathHead`)·hh, relative
  to the head, lands it at 0.03 hh with the shoulders.
- **AngleZ.** At ±30 the follow rolls the chin's cell by exactly β (the cell
  is a pure rotation there), so the head's own roll is `ROLL_DEG` − β
  (12.8°) and its world roll stays 14°. The neck island undoes the head's own
  roll only, so it rides the torso; the long hair hangs against the world
  roll.
- **BodyAngleZ alone.** The head's own roll is 0, and its world roll is the
  body's. The hair's hang reads AngleZ only, so the hair rolls rigidly with
  the head.
- **BodyAngleX, BodyAngleY and the AngleX follow** carry the head without
  turning it.

Without a body there is no body warp: `headDeformer` is the root, and rolls
14° and breathes 0.02 hh on its own. The model declares BodyAngleX/Y/Z
("Body Angle X/Y/Z", −10..10) only with a body.

**Provisional values.** Our own, to be picked by eye on Bob's full body; not
yet compared:

| Value         | Rule                                                                         | Provisional |
| ------------- | ---------------------------------------------------------------------------- | ----------- |
| `bodySlide`   | BodyAngleX ±10: the upper body slides this far, hh                           | 0.1         |
| `bodyNarrow`  | BodyAngleX ±10: it narrows by this share of its width, about its centre      | 0.05        |
| `bodyBow`     | BodyAngleY ±10: it rises (+) or bows (−) this far, hh                        | 0.06        |
| `bodyRoll`    | BodyAngleZ ±10 rolls it this many degrees about the hips                     | 4           |
| `bodyFollowX` | AngleX ±30: the body follows the head's turn at this share of BodyAngleX ±10 | 0.3         |
| `bodyFollowZ` | AngleZ ±30: the body follows the head's tilt at this share of `bodyRoll`     | 0.3         |

## The arms

With an `arm_L` or `arm_R` layer — one drawing of the whole arm, hanging,
its shoulder at the top — the arm hangs from the body warp as three parts on
two nested matrix deformers (`arms.ts`). An arm needs a `body`:
`parseLayerRoles` and the generator's own checks refuse one without it
(`auto-rig: arm_L needs a body layer …`), which `@ikijs/mcp` reports as
`{ ok: false }`.

**The pivots**, read off the widest opaque run of each crop row
(`rowRuns`); a row without one, or a layer without runs, reads as the whole
crop row:

- r_u, the upper arm's half-width under the deltoid cap, is half the median
  width over the rows 0.10–0.30 of the crop's height down;
- the shoulder pivot lies r_u under the centre of the first painted row, at
  the run centre of the row it lands in (r_u rows down, rounded);
- the elbow pivot is the centre of the row 0.42 (`ELBOW_AT`) of the way from
  the shoulder's row to the last painted row (an arm drawn with its hand),
  at that row's run centre;
- the cap radius is half the elbow row's run + 1 px, kept inside the crop.

Pivots are on the 0.01 grid. An arm too short for its width to put the
elbow's row under the shoulder's would rig inverted, so the rig refuses it
with `LayerGeometryError` (`{ ok: false }` from `@ikijs/mcp`). Each shoulder
is one of the body warp's pivots, so its cell is all weight 1 (see The body):
the arm rides the upper body rigidly — it lifts with the shoulders' breath,
rolls with BodyAngleZ and the follow of AngleZ, and slides on BodyAngleX
without being narrowed.

**The meshes.** All three parts are cut from the one crop: they share its
box, transform and texture rect (`partIdsOfRole` names them for the host), and
the bands meet on the seam, the elbow pivot's row. The upper arm (`arm_X`, the
role's own id) is the band from the crop's top to the seam; the forearm
(`forearm_X`) is the band from the seam to the crop's bottom alone. The elbow
cap (`elbow_X`) is its own part on `forearmDeformer_X`, centred on the elbow
pivot above the seam. Iki has no glue between meshes, and two bands hinged at
a seam open a wedge as wide as the arm on a bend; the cap turns about its own
centre, so it rotates into itself and keeps the joint covered at any bend.

The cap is drawn behind the upper arm, so at rest it is hidden and paints
nothing twice; a bend uncovers only the wedge the bands open. Its edge is not
a circle but the arm's contour, per ray: from the elbow, on each of 13 rays
over 0..π (15° apart), the generator walks 1 px at a time while the point is
strictly inside the widest run of its crop row, and stops `CAP_INSET` (3 px:
the contour's antialias column, a texel of the engine's linear filtering, one
spare) short of the exit (none on the two seam-end rays, so the cap meets the
bands' corners at a bend; 2 px on the next, 3 on the rest), at most the cap
radius and at least 1 px. A fan of
12 triangles fills that boundary less a ring, with the crop's own UVs; the
ring is `CAP_RIM` (0.25) of the cap radius wide and its UVs sweep the seam
row's edge cross-section round the arc (the right edge on the right half, the
left on the left), the outer vertex at the column just past the run (the
antialias column, clamped to the crop's first or last column when the run
fills the crop) and the inner one the ring's width in columns inward, so the
exposed wedge carries the painted line and fades as the painted edge does.
Both constants are our own.

**The deformers.** `armDeformer_X` is a matrix deformer hung from
`bodyWarp` at the shoulder; `forearmDeformer_X` hangs from it at the elbow.
Each has one `rotate` binding on its parameter:

| Parameter                     | Name              | Range, default | Turns                                    |
| ----------------------------- | ----------------- | -------------- | ---------------------------------------- |
| `ParamArmL` / `ParamArmR`     | Arm L / Arm R     | −8..32, 0      | the arm about the shoulder, 1° per unit  |
| `ParamElbowL` / `ParamElbowR` | Elbow L / Elbow R | −10..90, 0     | the forearm about the elbow, 1° per unit |

A positive value raises the arm outward on either side: a rotation is
CCW-positive, so an arm whose shoulder lies right of the body's axis (+x, the
character's left) turns CCW for +, and one left of it CW. The elbow's + is
the opposite turn: it bends the forearm toward the body, the flexion of a
hanging arm (hand to the belly or hip), and its − bends it a little outward.
Both ranges are our own, picked by eye on street: the shoulder runs from 8°
across the body (where the arm rests against the hip) to 32° out (past 30° the
sleeve's dome lifts off the shoulder line and bare skin shows); the elbow from
10° outward to 90° inward. The playground's sliders step by (max − min) / 100,
so each span is chosen to put 0, half the max, the max and the min on a step
(0.4 and 1). Both elbows at 45+ with the shoulders at 0 cross the hands in
front of the body: drive that pose with a little shoulder raise. Each pair is
declared only with its arm layer, after Body Angle X/Y/Z.

**Draw order:** hair_back < body < elbow_L, arm_L, forearm_L, elbow_R, arm_R,
forearm_R < face … < hair_front < forearm_pose_L, forearm_pose_R. The forearm
draws over the upper arm, which draws over the cap.

**The pose forearm.** A `forearm_pose_L` / `forearm_pose_R` layer (it needs
its arm: `auto-rig: forearm_pose_L needs an arm_L layer …`) is a second
forearm drawn raised, standing up from the elbow, that swaps in for the
hanging one (`forearm-pose.ts`). Its geometry is the shoulder rule run from
the bottom: r_e is half the median width over the rows 0.10–0.30 of the
crop's height up from the crop's bottom, and the pivot lies r_e above the last
painted row, at the run centre of the row the pivot lands in. The rig does not use that pivot: the part sits on
`armPoseDeformer_X`, a child of `armDeformer_X` pivoting at A's elbow, so
`ParamElbowX` never moves it and the shoulder still carries it; the
composer puts the drawing's elbow end on that pivot and `measure_layers`
warns when it is off. The part has no mesh: the engine draws a meshless part
as its full-box quad with its texture rect, and a rigid part needs no more.
The swap is a pair of opacity bindings on `ParamArmPoseX`: A's forearm and
elbow cap go 1 → 0, the pose forearm 0 → 1, exclusive by construction (the
upper arm never swaps).

| Parameter                                   | Name                                | Range, default | Does                                                        |
| ------------------------------------------- | ----------------------------------- | -------------- | ----------------------------------------------------------- |
| `ParamArmPoseL` / `ParamArmPoseR`           | Arm Pose L / Arm Pose R             | 0..1, 0        | 0 the hanging forearm, 1 the drawn one, a crossfade between |
| `ParamArmPoseAngleL` / `ParamArmPoseAngleR` | Arm Pose Angle L / Arm Pose Angle R | −15..15, 0     | the pose forearm about the elbow, 1° per unit               |

A positive value tips the raised hand outward, away from the body, mirrored
per side. The pose forearm points up from its pivot where the hanging
forearm points down, so its rotate binding takes −side × the value: the
elbow's multiplier, which gives the shoulder's reading. The range is our own,
picked by eye on street, the span 30 putting 0, ±7.5 and ±15 on the slider's 0.3
steps. The pair is declared only with the layer, right after that side's
Elbow. It is measured out of the head: a rest render does not show it, so
`createLayerSetMeasurer` keeps it out of the opaque union and the per-role
edges, while recording its `rowRuns`.

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
- **Cheek** — with a blush, `ParamCheek` (0..1, rest 0) fades each blush
  part's opacity from `blushRest` (0.4) up to 1: the blush rests faint, and an
  expression raises it to the look drawn. Without a blush there is no Cheek.
- **Mouth** — MouthForm lifts the corners and widens a little; with
  `mouth_open`, MouthOpen fades the closed lips out (twice, so they are gone
  by the time the open drawing is half grown) while the open drawing grows out
  of its top lip, both widening to 1.2×; without it, the closed mouth opens
  down to 0.8 of its width and widens to 1.2×.
  The **lip set** — `mouth_inner` (the interior with the opening's lower
  outline band), `lip_lower` (the lower lip's skin) and `lip_upper` (the upper
  lip line and the corner hooks), back to front — folds open the way the
  eyelid folds shut instead of crossfading (`mouth.ts`). Each part has one
  warp on MouthOpen that lands its own painted boundary per column, read off
  the layers' `rowRuns`: shut, the line comes down until its bottom edge is
  on the seam, 0.3 of the interior's height below its top (which also sets the
  closed line's curve), and the skin comes up under it by the overlap, the
  smaller of the centre stroke and the line's own thickness there; the
  interior's bottom rides the skin's top and its top closes onto the same
  edge, so shut it has no area, and the lower outline folds with the
  interior. The fold's keyform at 1 is zero (the fold alone leaves
  the drawing as it is), while the whole stack at MouthOpen 1 is the drawing
  widened 1.2× like `mouth_open`. The three share one MouthForm frame
  (their union's), so the corners stay joined. The mouth's anchor for the
  head's frame and the turn is the seam at the opening's centre. The path is
  chosen by the layers present: `mouth_open` crossfades, `mouth` alone
  stretches, the lip set folds; a partial set, or one mixed with `mouth` or
  `mouth_open`, is refused.
- **Roll** — the head rolls 14° in the world at AngleZ ±30 about the chin:
  on a body, the body's follow rolls the chin's cell β (1.2°) about the hips
  and `headDeformer` rolls the rest, 12.8°; without one, `headDeformer` rolls
  all 14°. The neck island undoes the head's own roll, so it stays on the
  torso. Long hair gives back 35 % of the world roll toward its ends
  (hanging); hair that ends above the chin (a fringe) rolls with the head.
  Keyed at AngleZ 0 and ±30. On BodyAngleZ the head and its hair roll with
  the body, unhung.
- **Hair sway** — with `hair_front`, two springs (`AngleX → HairSwayX`,
  `AngleZ → HairSwayZ`) drive root-pinned swings of both hair layers, their
  ends travelling 0.08 hh at full sway (±20), growing down the layer as
  `t^1.4`. A spring settles on its target, so a held turn keeps the hair a
  quarter swung toward it (a held roll, 40 %).
- **Breath** — the shoulders (and the neck) lift 0.03 hh, the head 0.02 hh.
  On a body, the body warp lifts the chin's cell with the shoulders, so the
  head's own breath is the difference, a 0.01 hh drop; the hips and what lies
  under them stay.

## Expressions and motions

Every rigged model declares three head motions and up to six expressions
(`animations.ts`), each with a description a host picks it by — an LLM
choosing from the descriptions, say. A term adds unless noted.

| Expression  | Terms                                                                                                         | Description                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `smile`     | MouthForm +1 · BrowLY/BrowRY +0.25 · Cheek +0.4                                                               | "Smiling and pleased: warm, friendly, content. For greetings, thanks, agreement and gentle happiness." |
| `laugh`     | EyeLOpen/EyeROpen 0 (multiply) · MouthForm +1 · MouthOpenY 0.8 (overwrite) · BrowLY/BrowRY +0.4 · Cheek +0.65 | "Laughing, eyes shut and mouth open: delighted, amused. For jokes, playfulness and big joy."           |
| `angry`     | BrowLY/BrowRY −0.5 · BrowLAngle +0.8 / BrowRAngle −0.8 · MouthForm −0.9                                       | "Angry or annoyed, frowning. For irritation, frustration, indignation or scolding."                    |
| `sad`       | BrowLY/BrowRY +0.35 · BrowLAngle −0.8 / BrowRAngle +0.8 · MouthForm −0.8                                      | "Sad or disappointed, downcast. For sorrow, regret, apology or sympathy."                              |
| `surprised` | BrowLY/BrowRY +0.8 · MouthOpenY 0.9 (overwrite)                                                               | "Surprised, mouth dropped open: startled, amazed. For shock, sudden news or disbelief."                |
| `shy`       | Cheek +1 · EyeBallY −0.65 (gaze down) · MouthForm +0.4 · BrowLAngle −0.25 / BrowRAngle +0.25                  | "Shy or embarrassed: bashful, flustered. For being praised, teased or caught off guard."               |

One clip per group, so a host plays (`Nod`, 0). Keys are `[t s, value]`. A
model with a pose forearm adds `Wave` (below the table).

| Group   | Curve  | Keys                                                        | Duration | Fade-in | Description                                                               |
| ------- | ------ | ----------------------------------------------------------- | -------- | ------- | ------------------------------------------------------------------------- |
| `Nod`   | AngleY | (0, 0) (0.3, −18) (0.6, 4) (0.8, −1) (1, 0)                 | 1.0 s    | 0.4 s   | "Nods yes: agreement, acknowledgement, understanding."                    |
| `Shake` | AngleX | (0, 0) (0.2, −18) (0.45, 18) (0.7, −16) (0.95, 10) (1.2, 0) | 1.2 s    | 0.15 s  | "Shakes the head no: disagreement, refusal, disbelief."                   |
| `Tilt`  | AngleZ | (0, 0) (0.35, 20) (1, 20) (1.4, 0)                          | 1.4 s    | 0.4 s   | "Tilts the head to one side and back: curiosity, puzzlement, a question." |

- **The Wave.** `defaultMotions(declared)` returns the head groups always
  and `Wave` only when `ParamArmR`, `ParamArmPoseR` and `ParamArmPoseAngleR`
  are all declared: the validator rejects a curve on an undeclared parameter,
  and a bust has none of them. "Waves hello with the right hand: greeting,
  goodbye, getting attention.", 2.2 s: the switch linear, 0 → 1 over the
  first 0.15 s, held, 1 → 0 over the last 0.15 s; `ParamArmR` a small lift
  (10) through the wave; `ParamArmPoseAngleR` three rocks (±12) between 0.5
  and 1.7 s. Every curve is keyed 0 at its first and last key. `fadeIn` and
  `fadeOut` equal the switch's ramp (0.15 s), because a clip's fade blends
  every curve, the switch included, and the default 0.4 s would stretch the
  crossfade. The values are our own, picked by eye on street.
- **Blends.** EyeOpen multiplies, so the procedural blink keeps running
  under it and at 0 the eyes stay shut. MouthOpenY overwrites, and a host's
  lip-sync, written after the expression, wins. Every other term adds onto a
  parameter that rests at 0, and the engine clamps the sum to its range.
- **The filter.** A model declares the brows, the gaze and Cheek only with
  the layers they move (`brow_L` / `brow_R`; an iris, pupil or highlight; a
  blush). An expression whose look rests on a missing part is left out, so a
  host never picks one the face cannot show: `shy` needs the blush, `angry`
  and `sad` need a brow. `smile`, `laugh` and `surprised` rest on the mouth
  and the eyes, which the rig always declares, so a model with only the
  required layers keeps those three. A kept expression keeps only its terms
  on parameters the model declares; each keeps a term on EyeOpen, MouthOpenY
  or MouthForm, so none is emptied. The head motions use ids that are always
  declared (the head angles); the Wave moves the right arm and its pose
  forearm, so it is attached only when its three ids are declared, which is
  why the motions are filtered too.
- **Brow signs.** Brow angles are raw per side and CCW-positive on screen.
  The character's left brow sits at +x, so its inner end is its screen-left
  end, which a CCW turn drops; the right brow's inner end is its screen-right
  end, which a CCW turn lifts. A mirror pair therefore takes opposite signs:
  `angry` is L +, R − (inner ends down); `sad` and `shy` are L −, R + (inner
  ends up).
- **Fades.** No expression sets a fade, so each fades over the format's
  `DEFAULT_FADE_SECONDS` (0.4 s); so do Nod and Tilt, capped at half the
  clip. Shake fades in over 0.15 s: its first swing peaks at 0.2 s, and the
  default fade damped it. The Wave fades in and out over its switch's 0.15 s
  ramp, and its switch curve is `linear`, so the crossfade lasts exactly the
  ramp. No other curve sets an interpolation, so each is `smooth`. There is
  no `Idle` group, so the procedural idle stays whole.
- **How the values were picked.** By eye, on Bob (with his blush) and the
  long-haired character, in 2026-10: soft, medium and strong candidates
  (0.7, 1 and 1.3 times a starting set of our own) for the expressions, the
  motions and `blushRest`, rendered side by side on both characters; the
  picked set was then confirmed as one clip on both. The strong set won for
  every expression and motion, the medium for `blushRest`; Shake's shorter
  fade-in was the one change of shape.

## Known limits

- The mouth fold shows no opening until the lips have parted about one stroke
  (MouthOpen ≈ w′/(H + w′)): the interior's top stays under the line's ink
  until `v·H > w′(1 − v)`. A mouth drawn as a dot, a
  single line or a `:3` has no opening to fold and stays on the legacy path.
  The seam's share, 0.3, is a constant until a character needs a knob.
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
- The neck island rides the head rigidly, while the torso under it narrows on
  the body's follow of the turn: at AngleX ±30 a neck point lands
  `bodyNarrow` × `bodyFollowX` (0.015) times its distance from the chin's x
  further out than the torso under it, about 1–2 px across the neck on the
  bust.
- The body warp's rotations are linear keyforms, so between the stops a point
  D from the hips lies on the chord of its arc, about D·θ²/8 short of it, θ
  the roll at the extreme (`bodyRoll` on BodyAngleZ, β on the follow).
- The cap's rim line steps in by `CAP_INSET` (tapering to none at the
  seam's ends, where it meets the bands' corners at a bend), and an arm painted with a soft silhouette edge wider
  than the inset shows a faint rim at rest.
- No glue between an arm's two bands: each turns rigidly, and only the cap
  covers the joint; nothing bends the sleeve's outline round the elbow.
- The arms draw behind the face and the front hair, so a raised hand can go
  under a side lock; the pose forearm draws above both.
- The swap is a crossfade, so midway both forearms show at half strength, and
  a clip interrupted mid-wave fades the switch back over its fade rather than
  snapping it.
- The legs never move: everything under the hips is planted.
- `laugh`'s shut eyes are the blink's fold, with no smile arch: the happy eye
  (an EyeSmile parameter) is deferred.
- `surprised` cannot widen the eyes: EyeOpen rests at its max.
- `shy`'s downward gaze barely shows on our characters: the iris travels only
  0.1 of its width up or down at full gaze, and `shy` asks for 0.65 of that.
- `sad` and `surprised` raise the brows under the bangs, which draw over
  them: where the bangs come down to the brows, the raise goes under them.
- A negative MouthForm only flattens a mouth drawn smiling, so on such art
  `angry` and `sad` read as a flat mouth rather than a frown.
