---
name: iki-character
description: Generate a renderable, auto-rigged Iki character (`.iki`) from one gesture — drive codex-image to draw role-separated transparent part PNGs (eyeless, noseless face base, nose, sclera, iris, closed + open mouth, lash, brow, front and back hair, torso, an optional cheek blush), compose them into canvas-aligned role layers with the `compose_layers_from_parts` MCP tool, then `auto_rig_from_layers` to emit a rigged `.iki` that blinks, gazes, lip-syncs, turns, nods and tilts its head with swaying hair, and emotes with its brows. Use whenever the user asks to "make/generate/create an Iki character" from scratch (no existing art).
---

# Iki Character (gen-AI → compose → auto-rig)

Turn "make me a character" into a renderable, animated `.iki` in one autonomous chain. This is the **skills** leg of the Iki north star ("good models FAST via gen-AI + MCP + skills") — the gen-AI leg (codex-image) and the MCP leg (`@ikijs/mcp`) already exist; this skill binds them.

```
codex-image (role-separated part PNGs)  →  compose_layers_from_parts  →  auto_rig_from_layers  →  rigged .iki  →  render-verify
                                           └────────────────── @ikijs/mcp ──────────────────┘
```

The hard part is **getting clean role-separated parts out of codex-image** (an eyeless face base, an iris-free white sclera) — most of this file is the hard-won prompt patterns and pitfalls that make that reliable.

## When to use

- The user asks to generate/create/make an Iki character, avatar, or model **from scratch** (there is no existing art to import).
- You want to demo the full gen-AI → rig pipeline end to end.

## When NOT to use

- The character comes back renderable but not good-looking enough, and you want
  it refined against a target look → that is the **iki-character-loop** skill,
  which drives this pipeline in a generator/critic loop. This skill is the
  single pass it calls.

- The user already has layered art (PNG layers or a PSD) → use the editor's "Import layer set" / PSD import path (`examples/editor`), not generation.
- The user wants engine/format/rig _capability_ work (new deformer, new role, blink mechanics) → that's a normal code slice, not this skill.
- The user wants to tweak an existing `.iki`'s parameters/poses → open the playground and drive it directly (deployed, via the Model picker; in a checkout, via `iki-visual-test`), don't regenerate.

## Prerequisites

- **An image generator** for Step 1. `gen-parts.sh` next to this file is the driver these prompts were tuned against: it shells out to `codex exec` with the built-in `image_generation` tool, attaches the reference to every job, and runs up to five at once. **Billed, minutes per image** — confirm the user is OK spending before starting. Anything that returns transparent, role-separated PNGs works; the prompts below are the substance, the driver is not.

  Jobs run on **`gpt-5.6-luna` at `model_reasoning_effort=low`** — the model only has to call the image tool, so depth buys nothing. Model slugs are **account-gated**: one your plan does not carry comes back as a `400`, not a fallback, so override with `CODEX_IMAGE_MODEL=<slug>` if that default is not yours. The script also passes `project_doc_max_bytes=0`, because the workdir sits inside the project and codex would otherwise inject the repo's `AGENTS.md` and `README.md` into every drawing job.

  **You cannot check quota up front.** `codex login status` reports authentication only — identical output before and after the limit is hit. A refused job exits non-zero with `You've hit your usage limit` and a reset time in its log, so on a big set fire one job and read it before firing the rest.

- **The three tools this skill needs** reachable: `compose_layers_from_parts` (Step 2), `measure_layers` (the same geometry checks on their own) and `auto_rig_from_layers` (Step 3). The plugin bundles the server (`.mcp.json` → `npx -y @ikijs/mcp`), so they are normally already in the tool list, plugin-scoped as `mcp__plugin_iki_iki__compose_layers_from_parts`, `mcp__plugin_iki_iki__measure_layers` and `mcp__plugin_iki_iki__auto_rig_from_layers` — look before doing anything else. When they are absent (server disabled) or you are developing `packages/mcp` and want the working-tree build, drive the **bin** over stdio instead:
  ```bash
  npx -y @ikijs/mcp                # standalone
  pnpm --filter @ikijs/mcp build   # in an iki checkout: produces packages/mcp/dist/cli.js
  ```
  then send JSON-RPC `tools/call` frames to that process (see Step 3). Either way the tools **confine everything they write to the server's cwd** (realpath-checked, atomic rename), so the MCP server's cwd — or the dir you launch the bin from — is where the layers and the model can be written.
- **A scratch workdir inside that cwd**, `iki-char/`, holding `parts/` (the generated part PNGs), `layers/` (the composed role layers), `layout.json` (the per-role placement overrides, starting as `{}` the first time), `mirror-parts.json` once a part has needed flipping (Step 2) and the finished `.iki`. Create it up front — but only seed `layout.json` if it is not already there, so re-running this skill in a workdir you already tuned (Step 2) does not throw that tuning away; the workdir is gitignored, so there is no repository copy to recover it from. Every example below uses these paths.
  ```bash
  mkdir -p iki-char/parts iki-char/layers
  [ -f iki-char/layout.json ] || echo '{}' > iki-char/layout.json
  ```

## The role set this skill generates (full-expression default)

Mirrors `@ikijs/editor` `ROLE_TABLE` / `REQUIRED_ROLES`. **Required:** `face`, `eye_L`, `eye_R`, `mouth`. The composer additionally emits `iris_L/R` (gaze), `lash_L/R` (blink-fold cover), `brow_L/R` (expression), `hair_front`, and the optional `nose`, `mouth_open`, `hair_back`, `body` and cheek blush `blush_L/R`. That set gives a character that **blinks (eyelid-fold), gazes, lip-syncs, turns / nods / tilts its head with hair that sways behind it, and raises/tilts its brows** — on a torso that breathes.

| codex-image part                                                  | composer output role(s)                              | drives                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `body.png` (torso to the waist and a long, slender neck, NO head) | `body`                                               | `bodyDeformer` — breathes; the head turn leaves it, its neck included, where it is, and the face slides over the neck                                                                                                                                                                                                                                                              |
| `hair_back.png` (hair behind the head)                            | `hair_back`                                          | stays behind the head through the turn (a slight counter-drift) while the face and front hair slide over it; its ends swing on the hair-sway springs                                                                                                                                                                                                                               |
| `face.png` (NO eyes, NO mouth, NO neck)                           | `face`                                               | its own turn × nod keyforms: the plate translates, the chin leading; drawn without a neck, it is all head and slides over the torso's neck (art whose face paints a neck under the jaw still works: that neck is cut off and stays still while the chin, and its shade, slides over it); ears painted on its sides lag it; roll about the chin, breath                             |
| `blush.png` (one cheek blush, optional)                           | `blush_L/R` (`blush_L` mirrored)                     | its own turn × nod keyforms, baked from the face plate's motion, so it stays on the cheek through the turn and nod; roll about the chin, breath; draws over the face, under the nose                                                                                                                                                                                               |
| `mouth.png` (closed)                                              | `mouth`                                              | MouthForm; fades out as MouthOpen rises when `mouth_open` is present                                                                                                                                                                                                                                                                                                               |
| `mouth_open.png` (open, same width)                               | `mouth_open`                                         | MouthOpen cross-fade — this is what makes lip-sync read as a mouth, not a smear                                                                                                                                                                                                                                                                                                    |
| `eyewhite.png` (white almond + dark lashes, **NO iris**)          | `eye_L/R` (split sclera) + `lash_L/R` (split lashes) | blink-fold (sclera = clip mask + fold; lash folds over the seam)                                                                                                                                                                                                                                                                                                                   |
| `iris.png` (colored disc + pupil + highlight)                     | `iris_L/R`                                           | gaze (EyeballX/Y), auto-clipped to the sclera                                                                                                                                                                                                                                                                                                                                      |
| `brow.png` (one eyebrow)                                          | `brow_L/R` (mirrored)                                | BrowY / BrowAngle                                                                                                                                                                                                                                                                                                                                                                  |
| `hair_front.png` (bangs)                                          | `hair_front`                                         | rides the face where it lies over it and holds the head's outline where it draws it, though on rows where the back hair paints behind that edge it may ride further, as far as that back hair reaches; its crown eases to the back hair's motion on the turn; on the nod its cap slides with the face as far as the back hair covers the crown; its ends swing on the hair springs |
| `nose.png` (the nose only)                                        | `nose`                                               | leads the turn and the nod furthest of all the features — the turn's strongest depth cue; at full turn it also tilts its tip toward the far side                                                                                                                                                                                                                                   |

The **nose** is a part of its own, like the eyes and the mouth. The features slide across the face on the turn and nod (depth parallax): the plate slides, the nose leads it, and the eyes, brows and mouth lead it by less — the Live2D samples' own amounts, which is what stops a turn from reading as a plate without making it read as a slide. Without a `nose` layer the plate and the other features still turn on the profile, but the turn loses its strongest cue and fits nothing — `turnTargets` is inert and the result carries no `turn` report (Step 3) — and `measure_layers` flags the nose as missing. `face.png` must therefore come back WITHOUT a nose: a nose that leaks onto the face stays on the plate while the real one moves, and the two drift apart on every turn.

Without `mouth_open`, MouthOpen stretches the closed mouth open (to 0.77 of its width, the Live2D samples' median) — fine for a portrait, a blurred band for lip-sync.

`body` rides its own `bodyDeformer`, never the head's, and it carries the neck: the neck never turns with the head (the Live2D samples move it 0 on the turn), so drawing it with the torso keeps the neck–shoulder junction one drawing and leaves the face nothing to cut. Without `body` the character has no neck or shoulders and reads as a floating head; painting shoulders into `face.png` instead is worse, because `face` rides the head's turn and the shoulders would slide with the head.

`eye_L/R` and `lash_L/R` both come from the **single** `eyewhite.png` — the composer's eye split divides it by luminance into a clean white sclera (the dark outline/lash recolored white = the clip-mask shape) and a dark **upper-lash** layer (only the top fraction of the dark pixels; the lower almond rim is dropped). Both are cropped to the **same** eye bbox and placed with `noTrim`, so the lash stays anchored ABOVE the sclera center — on blink it folds DOWN over the eye (like the sample model) instead of the whole eye shrinking in place. This is deliberate: asking codex-image for a _separately clean_ sclera and lash is less reliable than splitting one lashed white deterministically. A light mark drawn **detached above the white** — a double-eyelid crease — is dropped from the sclera, because the sclera is the iris's clip: kept, the fold carried it down into the iris's path at half blink, and the iris showed through it as a dashed line. Dark strokes there stay lash ink, so a dark crease line still shows, with the lash, and folds with it on blink.

## Procedure

### Step 1 — Generate role-separated parts with codex-image

Invoke the **codex-image** skill to generate the parts **in parallel** into the parts dir (`iki-char/parts/`). Keep a **shared style descriptor** in every prompt so the parts read as one character (same hair color, eye color, line weight, flat anime cel-shading). Demand a **transparent background, front-facing, centered** part. (If a part comes back opaque-on-white instead of transparent, the composer's `keyWhiteToAlpha` fallback keys near-white to alpha — but transparent is better.)

Prompt skeleton (fill `<STYLE>` consistently, e.g. "flat anime cel-shaded, soft lavender hair, blue eyes, clean line art"):

- **face.png** — "Front-facing anime character face base, `<STYLE>`. Skin, ears and the face shape only, with the jaw's outline drawn all the way round and CLOSED under the chin. **NO neck**: the drawing ends at the chin's outline. **NO eyes, NO eyebrows, NO nose, NO mouth, NO hair** — bare skin where features go. Transparent background, centered." _(The neck belongs to `body.png`. A face drawn without one is read as all head and slides over the torso's still neck; a neck painted on the face has to be cut out of it, and the cut shows as seams on the turn. "NO neck" is a negation like "NO nose", so generate 2 variants and pick the one that ends at its chin. A neckless face's box is its skull, and the default layout centres that box on the eye row's default, so the skull sits lower than a face with a painted neck: on bob, `layout.face.cy` 437 instead of the default 475 put the skull where the necked face's had been. If the turn ever shows a still sliver at the chin's tip, the rig read a long tapering chin as a painted neck — report it.)_
- **mouth.png** — "A single small closed anime mouth / lips, `<STYLE>`. Transparent background, centered, nothing else."
- **eyewhite.png** — "A single anime eye, `<STYLE>`: an almond-shaped **white sclera** with **dark upper eyelashes** along the top. **NO iris, NO pupil, NO colored disc** — just the white interior and the dark lash line. **NO double-eyelid crease line above the eye.** **The outer corner, where the lash flicks out into a wing, is at the LEFT end of the image; the inner corner, the tear duct with no lash, is at the RIGHT end.** Transparent background, one eye only." _(The "NO iris" negation is the flaky part — see Pitfalls. Generate 2–3 variants and pick the cleanest iris-free one. The direction is in image terms on purpose — see the left/right pitfall. The crease is negated because the eye split keeps only part of one — see the eye-split paragraph above.)_
- **iris.png** — "A single round anime iris disc, `<STYLE>` eye color: radial colored iris with a dark round pupil and a small white highlight glint, top. Transparent background, just the disc, no eyelid, no sclera, no lashes."
- **brow.png** — "A single anime eyebrow, `<STYLE>`. Transparent background, one brow only, gentle arch, **its thick head at the LEFT end of the image, tapering to a thin tail at the RIGHT end**."
- **nose.png** — "A single anime nose, `<STYLE>`, seen from the front, drawn as a soft SHADED BUMP, not as a line: a soft-edged, warm skin-shadow plane running down the LEFT side of the nose bridge from just below the eyes to the tip, a thin soft white highlight streak along the top of the bridge on the RIGHT side, a slightly deeper warm shadow tucked under the tip, and one tiny dark nostril mark. Clearly readable as a nose with volume, but still delicate anime proportions. Transparent background: only the nose shading itself, with the shadow fading to fully transparent at its edges — NO skin-coloured rectangle or patch, NO face, NO eyes, NO mouth, NO outline around it. Centered, one nose only." _(Optional but the whole head-turn depth cue hangs on it. Generate 2–3 variants — one run of this prompt got 2 usable of 3. A skin fill slightly darker than the face reads as the bump's shadow, so keep it. The composer sizes the nose by its DENSE CORE — the tight box of its pixels at alpha ≥ 128, about 40 px wide by default — and puts the core's tip 0.86 of the way from the eye row to the mouth. Retune `layout.nose` with `w`/`h` sizing that core and `cx` centring its columns. Leave `cy` unset so the tip stays on that 0.86 row and follows a retuned `eye_L`/`eye_R`/`mouth` `cy`; setting `cy` places the core's CENTRE row there instead of its tip, so the same number puts the nose about half the core's height lower. A core under a quarter of the part's width or height — a lone nostril mark or highlight — composes as the whole part instead and the report warns; regenerate the nose with its shading painted denser, not a layout retune.)_
- **hair_front.png** — "Front hair / bangs for an anime character, `<STYLE>`, framing an empty face from above: the bangs and the hair over the top of the head, drawn as ONE inner layer that a fuller back hair will surround. Its strands sweep up and converge into a single crown point at the top; its top and outer edges have NO outline stroke and NO stray flyaway strands, so they blend into the back hair behind them, while the bang tips keep their line art. Its side strands stop above the ears, leaving them uncovered unless the design hides them. Transparent background, front layer only (no back hair, no face)." _(Drawn as a whole hairstyle of its own — an outline, flyaways and a parting at its top — the front hair reads as a second head inside the back hair; on bob, the inner-layer wording largely removed that. Its first try let the side strands hang over bob's ears, hence the last sentence.)_
- **hair_back.png** — "Back hair for an anime character, `<STYLE>`: only the hair behind the head, shaped as a broad rounded bell — a complete dome over the crown reaching up past where the bangs' top will sit, with NO part line or dip, and voluminous sides that flare out well past the fringe and the front side hair on both the left and the right, its outline one solid mass with no thin strands floating outside it, falling behind the head and shoulders. Transparent background, no face, no bangs." _(Compose it larger and higher than the front hair, so its crown surrounds the front hair's top: the layout box, not the drawing, sets where that top lands. On bob, the back hair's box at the front hair's height left its top level with the front hair's and 24–33 px short at the crown's shoulders; `layout.hair_back` {cx 550, cy 390, w 555, h 522} (from {cy 405, w 545, h 493}: its top raised 30 px, its width +10) cleared the front hair's top by 5 px in every crown column. The front hair's cap slides on the nod only as far as back hair is painted behind its top, so a back hair that stops short of it, or dips at the parting, holds the cap's top nearly still. Compose it wider than the front hair beside the crown and temples, too: the front hair's outer edge turns with the face only as far as the back hair's solid mass reaches past it, about 0.16 hh on every row there (≈ 30 px at bob's 184 px head unit), a little more where the dome slopes. That reach is the back hair's painted edge as composed: its drawn shape and its layout box set it together, so check it on the composed layers, row by row against the front hair's painted edge, not on the box. A back hair no wider than the front hair there holds the cap's outline still on the turn, and a bell that flares only at the jaw adds none of that width. On bob, the box above reached 0–20 px past the front hair's sides and the cap's outline turned 0.45× the face; a regenerated bell at that same box reached less, its extra width lying at the jaw; `layout.hair_back` {cx 550, cy 374, w 666, h 550} reached at least 28 px there on every row the cap's edge passes over on the nod.)_
- **mouth_open.png** — "The same anime mouth as `mouth.png` but open mid-speech, `<STYLE>`: parted lips, dark interior, a hint of teeth. Same width and line weight as the closed mouth. Transparent background, centered, nothing else." _(The default layout gives it the same `cx`/`w` as `mouth` and aligns the top lip, so draw it the same width.)_
- **body.png** — "A front-facing anime character's torso shown down to the waistline, `<STYLE>`, simple clothing. Out of the collar rises a SLENDER, LONG neck, part of the same drawing: about one EIGHTH of the shoulder width, sticking up above the collar by more than its own width, its top cut flat (the face is drawn over it) and its side outlines flaring gently into the shoulders at the bottom. The neck is ONE flat, even skin-shadow tone a shade darker than face skin, from the cut down to the collar: NO cast shadow, NO V-shaped shadow, NO gradient, NO highlight. Keep the neck's side outlines. **Do not draw any head, face, chin, jaw line or hair.** Transparent background, centered, the composition about one and a half times as wide as it is tall." _(The neck stays still while the face slides over it, so its top must stay hidden behind the face through the turn, the nod and the roll. The framing sets the torso's scale against the face: `w` caps at the canvas and a torso that reaches its bottom fills it, so a chest-only drawing came out about 15% wider at the shoulders than bob's necked-face torso and made the face look small, while a waist-length one came out about 2% narrower. Place the torso so the neck's flat top sits well above the chin, behind the face's widest rows, and its bottom reaches the canvas's: on bob, `layout.body` {cx 550, cy 906, w 1100} put the top about 200 px above the chin. Tops 60–80 px above it showed their flat corners beside the jaw at the extremes (a full turn, looking up and a full roll at once), while 120 px did not; `h` may stretch a flat-toned torso by about 10% to lift a short neck's top, and shrinking `w` instead lowers it. The width matters too: on bob a 176 px neck showed its corners at the same extremes while ~145 px did not (bob's face-painted neck was 135). Word it as a torso: "upper body of an anime girl" came back as the whole character, head and all. Fire the two variants with differently worded prompts: the same prompt fired twice at once came back as two identical images.)_
- **blush.png** — "A single soft anime cheek blush, `<STYLE>`, for the cheek on the screen LEFT: one soft pink flush about twice as wide as tall, fading to fully transparent at its edges. **Its outer end, toward the face's edge, is at the LEFT end of the image; its inner end, toward the nose, is at the RIGHT end.** NO face, NO skin-coloured patch, NO outline, NO hatching lines or strokes. Transparent background, one blush only." _(Optional decoration: a parts dir without it composes, and the geometry report does not flag it missing. Keep it soft colour: a dark hatch or stroke would read as marks on the cheek rather than a flush. (This prompt has not yet been run through codex-image; the blush path was checked with a script-drawn ellipse.) The default layout puts it 56 px wide below each eye, tuned on the hero's face for a 2:1 blush: the face narrows fast below the eye row, and a wider, lower box ran past the cheek's outline. `blush_L` and `blush_R` are separate `layout` keys that only default to mirror images, so retune both.)_

Save each to the parts dir with the **exact filenames above** (`compose_layers_from_parts` expects them).

### Step 2 — Compose into canvas role layers

Call `compose_layers_from_parts` with the parts dir, the layers dir, whatever
`iki-char/layout.json` holds right now, and `iki-char/mirror-parts.json` when it
exists:

```jsonc
{
  "partsDir": "iki-char/parts",
  "outDir": "iki-char/layers",
  // the contents of iki-char/layout.json — `{}` until you tune something
  "layout": {},
  // the contents of iki-char/mirror-parts.json — leave it out until a part needs it
  "mirrorParts": [],
}
```

It alpha-trims (leaving out a faint speck detached from the drawing, which
would pull the part off its centre), resizes, mirrors L/R and pastes each part
at its layout center on a shared transparent 1100×1100 canvas, writing
role-named PNGs (`face.png`, `eye_L.png`, …) plus a flattened `preview.png` into
`iki-char/layers/` — which must already exist, since the tool never creates
it. The result carries the
written layer paths and, inline, the geometry report — which encodes the failure
modes that each cost a real regeneration round to find by eye
(iris/sclera ratio, a sclera too flat to hold a round iris, an iris off the
white's centre of mass, lash/sclera drift, an eye drawn facing the other way,
art cut through by its own frame).
Iterate until it reports `all geometry checks passed`.

An eye **drawn facing the other way** is fixed before anything else, and never
by retuning its iris: add `"eyewhite.png"` to `iki-char/mirror-parts.json` (a
JSON array) and recompose with it as `mirrorParts`. The composer flips the
source, so both eyes and both lashes flip together — free, no regeneration.
`brow.png` flips the same way if its head came out on the right, and
`blush.png` if its outer end did.

**Read `preview.png`** to check alignment. The built-in default layout assumes
the standard framing prompted above; if eyes/mouth/brows are off, edit
`iki-char/layout.json` (per-role `cx`/`cy`/`w`/`h`, e.g. `{ "eye_L": { "cx": 660 } }`; `h` stretches a part instead of keeping its aspect, which is how a sclera too flat to hold a round iris is fixed for free — set it on the sclera and its lash together or the blink fold tears)
and call the tool again — free, deterministic, and it does **not** re-bill, so
iterate freely. Before you change any `w`, read the iris pitfall below: `eye_*`,
`lash_*` and `iris_*` are four keys that have to move together.

`measure_layers` re-runs that same report over an existing layers dir
(`{ "layersDir": "iki-char/layers" }`) — for re-checking a layer set you did not
just compose.

### Step 3 — Auto-rig to a renderable `.iki` via MCP

Call `auto_rig_from_layers` with the layer paths `compose_layers_from_parts` returned (everything it wrote but `preview.png`) and an `outputPath` ending in `.iki` whose parent directory already exists. Input shape:

```jsonc
{
  "layers": [
    { "path": "iki-char/layers/body.png" },
    { "path": "iki-char/layers/hair_back.png" },
    { "path": "iki-char/layers/face.png" },
    { "path": "iki-char/layers/blush_L.png" },
    { "path": "iki-char/layers/blush_R.png" },
    { "path": "iki-char/layers/nose.png" },
    { "path": "iki-char/layers/eye_L.png" },
    { "path": "iki-char/layers/eye_R.png" },
    { "path": "iki-char/layers/iris_L.png" },
    { "path": "iki-char/layers/iris_R.png" },
    { "path": "iki-char/layers/lash_L.png" },
    { "path": "iki-char/layers/lash_R.png" },
    { "path": "iki-char/layers/mouth.png" },
    { "path": "iki-char/layers/mouth_open.png" },
    { "path": "iki-char/layers/brow_L.png" },
    { "path": "iki-char/layers/brow_R.png" },
    { "path": "iki-char/layers/hair_front.png" },
  ],
  "outputPath": "iki-char/iki-character.iki",
  "quantizeColors": 256,
}
```

Role is derived from the file basename (override per layer with `fileName` if needed). The tool decodes/crops/atlases itself (sharp, internal) and writes a renderable `.iki`, returning its path. A missing required role or a layer whose size ≠ the canvas comes back as `{ ok: false, error }` — fix the layers and retry.

`quantizeColors` palette-quantizes the atlas PNG. Flat-shaded art keeps its look at 256 colours and the model drops well below its lossless size (the hero demo: 3.18MB lossless → 1.28MB with `quantizeColors: 256`), which is what makes it loadable on a page. With a `nose` layer present, the nose alone stays on a second, lossless atlas page, because its soft shading would otherwise pick up the hair's palette entries and draw a rim. Leave it out while iterating on the art; put it in for the model you ship.

`style` is optional per-character tuning from the Live2D profile the rig defaults to — only what the Live2D samples themselves disagree on. Leave it out, or pass `{}`, for the profile as measured, and name only the knobs you change. It applies with or without a `nose` layer.

| Knob            | Default | Range | What it tunes                                                                                                                                                                                                                          |
| --------------- | ------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn`          | 1       | 0–3   | the whole head turn, as a multiple of the profile's — plate, features, hair and the eyes' foreshortening; ignored when `turnTargets.eyeShift` is given                                                                                 |
| `featureLead`   | 1       | 0–3   | how far the features lead the face plate, as a multiple of the profile's                                                                                                                                                               |
| `hairFollow`    | 1.1     | 0–2   | the front hair's share of the face's turn                                                                                                                                                                                              |
| `outlineFollow` | 0       | 0–2   | its outer edge's share where the front hair draws the head's outline (0: the outline holds, though where back hair paints behind it, it may ride further, as far as that back hair reaches; at `hairFollow` the side locks ride whole) |
| `blink`         | 0.58    | 0.1–1 | how far the upper lid comes down, over the eye's height                                                                                                                                                                                |
| `sway`          | 1       | 0–5   | the hair sway amplitude, as a multiple of the profile's                                                                                                                                                                                |

A value out of its range comes back as `INVALID: … style.<knob> …` (`style.turn 4 is outside [0, 3]`), and so does a knob not named here. Over MCP a `style` that is not an object, or a knob that is not a number, never reaches the tool: its input schema refuses it, and the SDK answers with an `isError` result reading `MCP error -32602: Input validation error: …`. A `turn` the art has no room for is not refused — it comes back clamped (below).

Leave `turnTargets` out: the rig then renders the Live2D profile, which is the default and every character's starting point, and `style` is how a character is tuned from it. Pass `turnTargets` only to match a measured front/turned pair literally — the cues `measure_turn_reference` reads off a front view and the same character turned at the same scale (`eyeShift`, `farEyeRatio`, `silhouetteRatio`, and optionally `noseShift` / `mouthShift`; the shifts are magnitudes, the sign is the turn's own business). Each cue given is fitted — `eyeShift` by the turn's amount (so `style.turn` is ignored beside it), `farEyeRatio` by the eyes' foreshortening, `silhouetteRatio` by the hair's width at full turn, `noseShift` / `mouthShift` by that feature's own shift — and an omitted one stays at the profile. The **iki-character-loop** skill no longer measures a pair: its drawn turned reference is a style check the critic reads by eye. `headHalfWidth` is not an input — the rig measures it off the layers and refuses one passed in — and a field not named here is refused too.

Either way the result reports that measured `headHalfWidth` alongside a `turn` report: `turn.achieved` is what the turn reaches (with no `turnTargets`, what the cues read on the profile's own turn), and `turn.clamped` names what the rig cut down to what this art can do — the turn itself, as `eyeShift` (yours, or the profile's times `style.turn`), past the room the art leaves: the far eye inside the face plate's edge, the chin over a neck the face paints (a torso's neck bounds nothing, so the turned renders are its check), and the far iris clear of the bangs' side strand where the rig measured one; and a profile `noseShift` / `mouthShift` past its own room. A clamp is not a refusal: the rig still built. A layer set with no `nose` (see Step 1) still turns on the profile and its `style` but fits nothing: the values in `turnTargets` are inert (a field not named here is still refused) and the result carries no `turn` report.

`turn.strandOverlap` gives, per side where the bangs cover the far iris, how much of its painted row they cover at its worst stop (`px`, `hh`), and how much at rest (`restPx`). `held: true` means the rig kept the iris no deeper under the bangs than it is painted; `held: false` means the art left no room, as with a fringe spanning the face, and `px` is what stays covered.

Any other target **you** passed that it cannot reach is still refused as `INVALID: … turnTargets.<field> …` — a `farEyeRatio` or `silhouetteRatio` out of the rig's reach, or a `noseShift` / `mouthShift` past its room. That is a fact about this character's geometry, not a number to tune: re-rig once without `turnTargets` and report the message verbatim, rather than loosening the measurement to make it fit.

Driving the **bin** over stdio when the server isn't registered — run it from the project dir, the same cwd the plugin's server has, so the `iki-char/…` paths resolve:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"auto_rig_from_layers","arguments":{"layers":[...],"outputPath":"iki-char/iki-character.iki"}}}' \
  | node <iki-checkout>/packages/mcp/dist/cli.js
```

### Step 4 — Render-verify

Load the `.iki` and confirm it renders + animates. Both paths use the Model
picker's "Load a .iki file…" entry to load it and drive the same parameters —
only the load order and how you address them (id vs. panel label) differ.

**Standalone (default):** open https://zeikar.dev/iki/playground/ (Playwright
MCP or a normal browser) and **uncheck Idle before loading anything** —
`load()` resets every parameter to its default, and idle only restarts if the
checkbox is still checked at load time, so unchecking first is what makes the
rest screenshot genuine. Unchecking Idle _after_ loading is too late: idle has
already written a live pose (angle, gaze, breath) into the parameters by then,
and this build has no `reset()` to undo it. With Idle off, open the Model
select, choose the trigger entry, and pick the model's **absolute** path
(`browser_file_upload` requires one — the relative `iki-char/iki-character.iki`
will not resolve). The panel's sliders carry no `id`/`data-*`, only each
parameter's friendly label, so drive it **by label**: find the `.control`
block whose label text matches, set that block's `input[type=range]` value,
and dispatch an `input` event (`browser_evaluate`), then screenshot
before/after.

| id                                                                    | panel label                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------ |
| `ParamEyeLOpen` / `ParamEyeROpen`                                     | Eye L / Eye R (blink-fold)                                   |
| `ParamEyeBallX` / `ParamEyeBallY`                                     | Gaze X / Gaze Y                                              |
| `ParamMouthOpenY` / `ParamMouthForm`                                  | Mouth Open / Mouth Form                                      |
| `ParamAngleX` / `ParamAngleY` / `ParamAngleZ`                         | Head Angle / Head Angle Y / Head Angle Z (turn / nod / tilt) |
| `ParamBrowLY` / `ParamBrowRY` / `ParamBrowLAngle` / `ParamBrowRAngle` | Brow L Y / Brow R Y / Brow L Angle / Brow R Angle            |

A clean console (no `IkiFormatError`/WebGL error) plus visibly-driving
parameters = success.

**Inside an `iki` checkout:** `pnpm playground`, load the file through the same
picker, then drive `window.__iki.setParam` / `reset` / `nextFrame` by id per
the **iki-visual-test** skill (repo-local, not part of this plugin) — same
parameters and success criterion as above.

`ParamHairSwayX`/`ParamHairSwayZ` (panel label "Hair Sway X"/"Hair Sway Z") are
physics OUTPUTS: the springs write them, so do not judge the hair from a
frozen pose — physics only advances inside the playground's idle loop.
Recheck Idle and watch, or drive the sway parameters directly — `setParam` in
a checkout, the panel slider standalone — to see the root-pinned swing shape.

## Pitfalls (hard-won — read before generating)

- **"NO nose" on the face is the same kind of negation.** A leaked nose stays painted on the face plate while the `nose` layer moves, so the two drift apart on the turn. Generate 2 face variants and pick the nose-free one; if both leak, strengthen the negation ("smooth bare skin between the eyes, no nose at all").
- **"Left" and "right" do not say which way a part faces.** "Draw the left eye" reads as the viewer's left or the character's, and a prompt that names no side leaves it to chance: all three eyewhite variants of one run came back reversed, with the lash wings pointing at the nose. The iris-offset warnings that follow tempt an iris retune, which hides the fault instead of fixing it. So the prompts above name the direction in image terms, and the geometry report flags an eye whose lash stops short of its outer corner instead of its tear duct; the fix is `mirrorParts` (Step 2). The entry describes the part FILE, not the character — when you regenerate that part, take it out of `mirror-parts.json` and let the report say again.
- **"NO iris" on the eyewhite is the flakiest prompt.** codex-image often paints an iris anyway. Generate **2–3 eyewhite variants** and pick the cleanest iris-free one; a leaked colored iris breaks `prepEyeSplit` (the luminance split would misclassify a dark/saturated iris as lash). If all variants leak, regenerate with a stronger negation ("empty white interior, absolutely no colored circle").
- **The eyewhite must be a SOLID FILLED white almond, not an outline.** The first generation often comes back as a thin line-art ring with a transparent interior — useless as a clip mask. Demand "SOLID FILLED pure-white almond, the entire interior painted opaque white". The blink-fold also reads best when the **upper lash is the boldest dark element**; a heavy full-almond outline still works (the split keeps only the top fraction as the lash via `LASH_KEEP_FRACTION`), but a clean white with a distinct top lash folds most cleanly.
- **The face base must have NO eyes and NO mouth.** A face with baked eyes can't blink/gaze (the eye stack would double up). Re-prompt until the eye/mouth sockets are bare skin.
- **Size the iris off the sclera, not by eye.** The default layout sizes the iris at 0.5625 of the sclera width (the reference measured 0.70–0.73; anything under ~0.45 reads as a bead). `lash_L`/`lash_R.w` are separate keys that merely default to the same width, so an override of `eye_L`/`eye_R.w` must set all four, plus a matching `iris_L`/`iris_R.w` — otherwise `compose_layers_from_parts` rejects the lash that no longer matches its sclera, or the geometry report flags the iris ratio. The auto-rig clips iris→sclera at runtime, so a big iris cannot spill — the real failure is the opposite one, and it already shipped: the first generated sample had an iris 32% of the sclera width and read as a bead floating in white.
- **Opaque-on-white parts** are handled by `keyWhiteToAlpha` (keys >238 RGB to alpha), but transparent output is cleaner — ask for it. White-rimmed parts (e.g. a white highlight on the iris) can be clipped by the key; prefer transparent generation for those.
- **Style drift across parts.** Independent generations can mismatch hue/line-weight. Keep one `<STYLE>` string identical across every prompt; regenerate the outlier, not the whole set.
- **Don't commit generated character art or reference models — and don't derive art from one.** The workdir sits inside the project, so `.gitignore` is the only thing keeping it out of the repo: the `iki` repo ignores `iki-char/` and `Hiyori/`; in any other project, add `iki-char/` before the first run. Keep every generated PNG and `.iki` under it — written anywhere else, they land in a commit. Studying a sample's _rig_ is fine: load it in its own runtime, watch how its turn reads, build our own bend to match the technique — that is observing rendered output and applying a method. Feeding its _art_ to codex-image is not: the generated character then carries that character's design. Hiyori's per-character terms forbid that — no changes of any kind to the design — and the Free Material Agreement counts it as 流用, diverting the material into models made with third-party software. `.gitignore` stops distribution, not derivation. The plugin ships the **skill and its prompts** — no art.

## What this skill does NOT change

No engine or format changes — this is prompts and procedure. The composer and the geometry checks ship in `@ikijs/mcp` (`compose_layers_from_parts`, `measure_layers`) beside the capability that already shipped in earlier slices (`auto_rig_from_layers`, the role table, blink-fold/gaze/brow rigging); the plugin pins that server at `^0.13.2` in `.mcp.json` (the nose part and the nose-keyed parallax need 0.7; `measure_turn_reference` and the `turnTargets` input of `auto_rig_from_layers` need 0.8; the iris-strand bound and the clamped `eyeShift` need 0.9; `mirrorParts`, the check for an eye drawn facing the other way and the refusal of an eye pair placed apart need 0.10; the nose's dense-core sizing, its turn tilt and its lossless atlas page need 0.11; the speck-core nose guard needs 0.11.1; the Live2D-profile rig, its `style` knobs and the refusal of an unknown `turnTargets` or `style` field need 0.12; the blush part and the sclera that drops a detached crease need 0.13; the crop that leaves out a stray speck needs 0.13.1; the front hair riding over painted back hair on the turn and its cap sliding on the nod need 0.13.2) and calls the tools. No changeset — the plugin is not an npm package.
