# Iki Character — the full body

The full-body path of the **iki-character** skill: a body drawn from the neck
to the shoes, one arm drawn for both sides, and a canvas grown downward to hold
them. Every step of `SKILL.md` still runs; this file says what a full body adds
to Steps 0–3.

## When

Only when the user asks for a full body. It is opt-in per character: a full
body is a `canvasHeight` over 1100 plus an `arm.png`. A bust never reads this
file, and its flow is unchanged.

The head keeps the bust's size and place. The canvas grows downward from its
top-left corner, so the face and hair parts, their prompts and their layout
are the bust's, drawn against `reference.png` as `SKILL.md` says.

## Step 0 — The full-body reference and the canvas height

Draw `iki-char/reference.png` as `SKILL.md` Step 0 says: it stays the master.
Once it is final, run the **iki-create-image** skill's
`gen-full-reference.sh iki-char/reference.png iki-char`. It draws
`iki-char/reference-full.png` from it: the same character head to toe, arms in
a slight A-pose, on a 1:3 portrait. It is one more billed image. Check it
against that skill's redraw list before drawing any part. A restart reuses it.

Read the figure's height in heads off `reference-full.png`: crown to soles,
over crown to chin. The crown is the top of the hair.

The canvas height is then H = 128 + heads × 533 + ~100, rounded up to even:

- 128 is bob's crown row and 533 his crown-to-chin height, measured on his
  composed layers. The face's defaults are his, so a head composed on them
  lands about there; the hair's layout moves the crown a little.
- ~100 px is the margin under the soles.
- 6 heads → 3426, 6.5 → 3694, 7 → 3960.

Write it to `iki-char/canvas.json`:

```json
{ "canvasHeight": 3694 }
```

Over 4096 (past about 7¼ heads), stop and tell the user. The composer's canvas
ends at 4096, and the head's scale is fixed: the canvas grows to fit the
figure, and the head never shrinks to fit the canvas.

## Step 1 — The body and the arm, against the full-body reference

Each `gen-images.sh` run attaches one `--ref`, so draw the parts in two runs:

- the face and hair parts — every part `SKILL.md` Step 1 lists but `body.png`
  — with `--ref iki-char/reference.png`, as for a bust;
- `body.png` and `arm.png`, with `--ref iki-char/reference-full.png`.

Keep the one `<STYLE>` string in both. The two prompts below replace the
bust's `body.png` prompt.

- **body.png** — "A front-facing anime paper-doll body, `<STYLE>`, in the
  reference's outfit, drawn from the neck down to the shoes. Out of the collar
  rises a SLENDER, LONG neck, part of the same drawing: about one EIGHTH of the
  shoulder width, sticking up above the collar by more than its own width, its
  top cut flat (the face is drawn over it) and its side outlines flaring gently
  into the shoulders at the bottom. The neck is ONE flat, even skin-shadow tone
  a shade darker than face skin, from the cut down to the collar: NO cast
  shadow, NO V-shaped shadow, NO gradient, NO highlight. Keep the neck's side
  outlines. **NO arms**: each shoulder ends in a clean, rounded outline, and the
  torso's sides are drawn complete from the armpit down, with NO gap, NO shadow
  and NO sleeve where an arm would join. **Do not draw any head, face, chin, jaw
  line or hair.** Legs straight, with a clear gap between them from the crotch
  down, feet flat. Transparent background, centered, with empty margin below the
  soles. A portrait image three times as tall as it is wide." _(Generate 2–3
  variants, each worded differently: the same prompt fired twice at once came
  back as two identical images. Open one as "an anime paper-doll body", one as
  "an anime mannequin dressed in the reference's outfit", one as "a full-length
  dress form wearing the reference's outfit, standing on two legs"; keep the
  rest. The neck is the bust's, for the bust's reason: the face slides over it,
  so its flat top has to stay hidden behind the face through the turn, the nod
  and the roll. The arms are drawn on their own and hung over the shoulders, so
  the torso must be whole where they join: a raised arm uncovers it. The rig
  plants the legs below the hip line, the first row 35–75% of the way down the
  body where two legs show apart; with no gap there, it plants them halfway down
  the body, so keep the gap.)_
- **arm.png** — "One anime character's arm, `<STYLE>`, dressed as in the
  reference, drawn on its own as a paper-doll piece: the arm on the SCREEN LEFT
  of a front-facing figure, hanging relaxed. Its shoulder is at the TOP of the
  image, toward the image's RIGHT, and the arm slants down and a little to the
  LEFT to a relaxed, open hand at the bottom — a slight A-pose. The shoulder is
  drawn as a rounded sleeve cap, fully outlined, closed by its own line all the
  way round. Only the arm: NO torso, NO collar, NO head. Transparent background,
  the arm centred with margin on every side. A portrait image three times as
  tall as it is wide." _(Generate 2 variants, the second worded as "a puppet's
  arm piece". Word it as a paper doll or a puppet, never "severed", "detached"
  or "cut off": gore-adjacent wording risks a refusal. The composer makes both
  arms from it, `arm_R` as drawn and `arm_L` mirrored. The rig turns it about
  its shoulder cap's centre and bends it at an elbow 0.42 of the way down to the
  hand, so draw the whole arm, hand included, longer than it is wide. A hand
  that came out at the lower RIGHT is the other side's arm: add `"arm.png"` to
  `iki-char/mirror-parts.json` and recompose — free.)_

## Step 2 — Compose the tall canvas

Pass `canvasHeight` from `iki-char/canvas.json` on every compose.

**The body.** Set `layout.body` in `iki-char/layout.json` before the first
compose; the bust's default lands it mid-canvas.

- `w` = the reference's body width × (533 / the reference's crown-to-chin
  height), both read on `reference-full.png`. The body width is its widest
  span without the arms: shoulder to shoulder where the arms join, or a
  skirt's hem where that is wider.
- Compose once and read, from the result's `layers`, the body's `height` and
  the chin's row: the face's `top + height`, ~661 on the default layout. This
  pass only measures; skip its report, as the body is not placed yet.
- Set `cy` so the body's top sits ~200 px above the chin:
  `cy = chin - 200 + height / 2`. That is bob's neck (209 px above his chin),
  and the bust's `body.png` note in `SKILL.md` says why. Compose again; with
  `w` unchanged the height stays the same.

**The arms.** They start on their derived defaults. `w` is 0.4 of the body's
width, and each shoulder pivot hangs on the body box's shoulder corner, 0.12
of its height under its top. Read `preview.png` against `reference-full.png`
for two things:

- the shoulder line: where each arm's top meets the torso;
- the fingertips' height on the thigh, which `w` sets (the arm keeps its
  aspect).

Then tune `layout.arm_R` and `layout.arm_L` together. As with the eye pair,
they are separate keys that only default to mirror images. Leave `cx` / `cy`
unset while tuning `w`: the shoulder then stays hung on the corner. A set `cx`
or `cy` centres the arm's box, as for every other role, not its pivot: start
from the box the compose placed (`left + width / 2`, `top + height / 2` in the
result) and move from there.

**The report's full-body checks**, each fixed for free:

- **Feet cut** (`body: its bottom row is the canvas's last`): raise
  `canvasHeight` in `canvas.json` and recompose. The canvas grows downward and
  nothing else moves. Regenerate `body.png` only if the drawing itself stops
  short of the soles.
- **An arm's cap off the torso** (`arm_R: its shoulder cap reaches …`): move
  that arm's `cx` toward the body by the px the warning names. When the body
  has no paint on the pivot's row at all, move the arm's `cy` onto the
  shoulder instead.

## Step 3 — Rig

Add `arm_L` and `arm_R` to the layers, with everything else the compose wrote
but `preview.png`.

- An atlas page can reach 4096 px on a side. A device whose WebGL limit is
  2048 then loads the model with those parts untextured; a limit of 4096 or
  more is near universal.
- A lossless full body runs ~6–8 MB. Put `quantizeColors: 256` in for the
  model you ship, as for a bust.

## Pitfalls

- **Arms leaked into `body.png`.** "NO arms" is a negation like "NO nose", so
  check every variant. Painted arms never move while the arms over them do.
  Hanging beside the torso, they also show as legs to the rig: it plants the
  hips at the waist. Regenerate rather than ship one.
- **Outfit drift between the two references.** The face parts come from
  `reference.png` and the body from `reference-full.png`, and the collar shows
  both. Compare the two before drawing any part, and redraw the full-body
  reference if its outfit, colours or head drifted.
- **The arm's pose must match the reference's.** `ParamArm` 0 is the pose as
  drawn, so an arm drawn straight down rests straight down on an A-pose
  figure. Pick the variant whose slant matches `reference-full.png`.
- **White clothes on an opaque part.** A part that comes back on white, with
  no transparency, has its near-white keyed to alpha by `keyWhiteToAlpha`, and
  a white shirt, sock or shoe keys out with it. Ask for transparency, and
  regenerate a part that wears white and came back opaque.
