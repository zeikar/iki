---
name: iki-character
description: Generate a renderable, auto-rigged Iki character (`.iki`) from one gesture — drive codex-image to draw role-separated transparent part PNGs (eyeless face base, sclera, iris, closed + open mouth, lash, brow, front and back hair, torso), compose them into canvas-aligned role layers with the `compose_layers_from_parts` MCP tool, then `auto_rig_from_layers` to emit a rigged `.iki` that blinks, gazes, lip-syncs, turns, nods and tilts its head with swaying hair, and emotes with its brows. Use whenever the user asks to "make/generate/create an Iki character" from scratch (no existing art).
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
- **A scratch workdir inside that cwd**, `iki-char/`, holding `parts/` (the generated part PNGs), `layers/` (the composed role layers), `layout.json` (the per-role placement overrides, starting as `{}` the first time) and the finished `.iki`. Create it up front — but only seed `layout.json` if it is not already there, so re-running this skill in a workdir you already tuned (Step 2) does not throw that tuning away; the workdir is gitignored, so there is no repository copy to recover it from. Every example below uses these paths.
  ```bash
  mkdir -p iki-char/parts iki-char/layers
  [ -f iki-char/layout.json ] || echo '{}' > iki-char/layout.json
  ```

## The role set this skill generates (full-expression default)

Mirrors `@ikijs/editor` `ROLE_TABLE` / `REQUIRED_ROLES`. **Required:** `face`, `eye_L`, `eye_R`, `mouth`. The composer additionally emits `iris_L/R` (gaze), `lash_L/R` (blink-fold cover), `brow_L/R` (expression), `hair_front`, and the optional `mouth_open`, `hair_back` and `body`. That set gives a character that **blinks (eyelid-fold), gazes, lip-syncs, turns / nods / tilts its head with hair that sways behind it, and raises/tilts its brows** — on a torso that follows the turn a little and breathes.

| codex-image part                                         | composer output role(s)                              | drives                                                                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `body.png` (shoulders/chest, NO head)                    | `body`                                               | `bodyDeformer` — a light share of the head turn and half the head's breath bob                                           |
| `hair_back.png` (hair behind the head)                   | `hair_back`                                          | follows the head turn and bends with it; its ends swing on the hair-sway springs                                         |
| `face.png` (NO eyes, NO mouth)                           | `face`                                               | turn × nod cylinder warp (`warp2d`), tilt, breath                                                                        |
| `mouth.png` (closed)                                     | `mouth`                                              | MouthForm; fades out as MouthOpen rises when `mouth_open` is present                                                     |
| `mouth_open.png` (open, same width)                      | `mouth_open`                                         | MouthOpen cross-fade — this is what makes lip-sync read as a mouth, not a smear                                          |
| `eyewhite.png` (white almond + dark lashes, **NO iris**) | `eye_L/R` (split sclera) + `lash_L/R` (split lashes) | blink-fold (sclera = clip mask + fold; lash folds over the seam)                                                         |
| `iris.png` (colored disc + pupil + highlight)            | `iris_L/R`                                           | gaze (EyeballX/Y), auto-clipped to the sclera                                                                            |
| `brow.png` (one eyebrow)                                 | `brow_L/R` (mirrored)                                | BrowY / BrowAngle                                                                                                        |
| `hair_front.png` (bangs)                                 | `hair_front`                                         | rides the face warp, leads it a little on the turn, slides with the brows on the nod; its ends swing on the hair springs |
| _(none — cut out of `face.png` by the composer)_         | `nose`                                               | leads the turn and the nod: the depth cue the other features are keyed to                                                |

The composer cuts the **nose** out of `face.png` into its own `nose` layer (the non-skin pixels between the eyes, from the eye line down to the mouth; the face gets skin filled in behind it). With that layer present the features slide across the face on the turn and nod (depth parallax): the contour only foreshortens, the nose leads, and the eyes, brows and mouth follow on the surface — small amounts, tuned by eye, which is what stops a turn from reading as a plate without making it read as a slide. Without it (no drawn nose to cut, a cut the composer declined because it looked like shading, or a layer set that never went through the composer) nothing slides: a painted-on nose left behind by moving eyes reads worse than no parallax.

Without `mouth_open`, MouthOpen stretches the closed mouth (`scaleY` up to 3×) — fine for a portrait, a blurred band for lip-sync.

`body` rides its own `bodyDeformer`, never the head's: without it the neck ends in mid-air and the character reads as a floating head; painting shoulders into `face.png` instead is worse, because `face` rides the head-turn warp and the shoulders would bend with the head.

`eye_L/R` and `lash_L/R` both come from the **single** `eyewhite.png` — the composer's eye split divides it by luminance into a clean white sclera (the dark outline/lash recolored white = the clip-mask shape) and a dark **upper-lash** layer (only the top fraction of the dark pixels; the lower almond rim is dropped). Both are cropped to the **same** eye bbox and placed with `noTrim`, so the lash stays anchored ABOVE the sclera center — on blink it folds DOWN over the eye (like the sample model) instead of the whole eye shrinking in place. This is deliberate: asking codex-image for a _separately clean_ sclera and lash is less reliable than splitting one lashed white deterministically.

## Procedure

### Step 1 — Generate role-separated parts with codex-image

Invoke the **codex-image** skill to generate the parts **in parallel** into the parts dir (`iki-char/parts/`). Keep a **shared style descriptor** in every prompt so the parts read as one character (same hair color, eye color, line weight, flat anime cel-shading). Demand a **transparent background, front-facing, centered** part. (If a part comes back opaque-on-white instead of transparent, the composer's `keyWhiteToAlpha` fallback keys near-white to alpha — but transparent is better.)

Prompt skeleton (fill `<STYLE>` consistently, e.g. "flat anime cel-shaded, soft lavender hair, blue eyes, clean line art"):

- **face.png** — "Front-facing anime character face base, `<STYLE>`. Skin, nose, ears, face shape and a SHORT neck ending just below the jaw. **NO eyes, NO eyebrows, NO mouth, NO hair** — bare skin where features go. Transparent background, centered." _(The neck bound is load-bearing: the default layout anchors this part on its bounding-box centre, so a long neck drags the skull up and the eye line lands too low on it. One run came back with 23% neck and needed a `layout.face.cy` retune to put the eyes back at ~53% of skull height.)_
- **mouth.png** — "A single small closed anime mouth / lips, `<STYLE>`. Transparent background, centered, nothing else."
- **eyewhite.png** — "A single anime eye, `<STYLE>`: an almond-shaped **white sclera** with **dark upper eyelashes** along the top. **NO iris, NO pupil, NO colored disc** — just the white interior and the dark lash line. Transparent background, one eye only." _(The "NO iris" negation is the flaky part — see Pitfalls. Generate 2–3 variants and pick the cleanest iris-free one.)_
- **iris.png** — "A single round anime iris disc, `<STYLE>` eye color: radial colored iris with a dark round pupil and a small white highlight glint, top. Transparent background, just the disc, no eyelid, no sclera, no lashes."
- **brow.png** — "A single anime eyebrow, `<STYLE>`. Transparent background, one brow only, gentle arch."
- **hair_front.png** — "Front hair / bangs for an anime character, `<STYLE>`, framing an empty face from above. Transparent background, front layer only (no back hair, no face)."
- **hair_back.png** — "Back hair silhouette for an anime character, `<STYLE>`, the mass of hair that falls behind the head and shoulders. Transparent background, no face, no bangs."
- **mouth_open.png** — "The same anime mouth as `mouth.png` but open mid-speech, `<STYLE>`: parted lips, dark interior, a hint of teeth. Same width and line weight as the closed mouth. Transparent background, centered, nothing else." _(The default layout gives it the same `cx`/`w` as `mouth` and aligns the top lip, so draw it the same width.)_
- **body.png** — "Head-less shoulders and upper chest of an anime character, `<STYLE>`, front-facing, simple clothing. **NO head, NO neck stump, NO face** — the shoulder line and torso only. Transparent background, centered."

Save each to the parts dir with the **exact filenames above** (`compose_layers_from_parts` expects them).

### Step 2 — Compose into canvas role layers

Call `compose_layers_from_parts` with the parts dir, the layers dir, and whatever
`iki-char/layout.json` holds right now:

```jsonc
{
  "partsDir": "iki-char/parts",
  "outDir": "iki-char/layers",
  // the contents of iki-char/layout.json — `{}` until you tune something
  "layout": {},
}
```

It alpha-trims, resizes, mirrors L/R and pastes each part at its layout center on
a shared transparent 1100×1100 canvas, writing role-named PNGs (`face.png`,
`eye_L.png`, …) plus a flattened `preview.png` into `iki-char/layers/` — which
must already exist, since the tool never creates it. The result carries the
written layer paths and, inline, the geometry report — which encodes the failure
modes that each cost a real regeneration round to find by eye
(iris/sclera ratio, a sclera too flat to hold a round iris, an iris off the
white's centre of mass, lash/sclera drift, art cut through by its own frame).
Iterate until it reports `all geometry checks passed`.

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

`quantizeColors` palette-quantizes the atlas PNG. Flat-shaded art keeps its look at 256 colours and the model drops to about a quarter of its lossless size (the hero demo: 3.5MB → 0.9MB), which is what makes it loadable on a page. Leave it out while iterating on the art; put it in for the model you ship.

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

- **"NO iris" on the eyewhite is the flakiest prompt.** codex-image often paints an iris anyway. Generate **2–3 eyewhite variants** and pick the cleanest iris-free one; a leaked colored iris breaks `prepEyeSplit` (the luminance split would misclassify a dark/saturated iris as lash). If all variants leak, regenerate with a stronger negation ("empty white interior, absolutely no colored circle").
- **The eyewhite must be a SOLID FILLED white almond, not an outline.** The first generation often comes back as a thin line-art ring with a transparent interior — useless as a clip mask. Demand "SOLID FILLED pure-white almond, the entire interior painted opaque white". The blink-fold also reads best when the **upper lash is the boldest dark element**; a heavy full-almond outline still works (the split keeps only the top fraction as the lash via `LASH_KEEP_FRACTION`), but a clean white with a distinct top lash folds most cleanly.
- **The face base must have NO eyes and NO mouth.** A face with baked eyes can't blink/gaze (the eye stack would double up). Re-prompt until the eye/mouth sockets are bare skin.
- **Size the iris off the sclera, not by eye.** The default layout sizes the iris at 0.5625 of the sclera width (the reference measured 0.70–0.73; anything under ~0.45 reads as a bead). `lash_L`/`lash_R.w` are separate keys that merely default to the same width, so an override of `eye_L`/`eye_R.w` must set all four, plus a matching `iris_L`/`iris_R.w` — otherwise the geometry report flags the lash drift, the iris ratio, or both. The auto-rig clips iris→sclera at runtime, so a big iris cannot spill — the real failure is the opposite one, and it already shipped: the first generated sample had an iris 32% of the sclera width and read as a bead floating in white.
- **Opaque-on-white parts** are handled by `keyWhiteToAlpha` (keys >238 RGB to alpha), but transparent output is cleaner — ask for it. White-rimmed parts (e.g. a white highlight on the iris) can be clipped by the key; prefer transparent generation for those.
- **Style drift across parts.** Independent generations can mismatch hue/line-weight. Keep one `<STYLE>` string identical across every prompt; regenerate the outlier, not the whole set.
- **Don't commit generated character art or reference models — and don't derive art from one.** The workdir sits inside the project, so `.gitignore` is the only thing keeping it out of the repo: the `iki` repo ignores `iki-char/` and `Hiyori/`; in any other project, add `iki-char/` before the first run. Keep every generated PNG and `.iki` under it — written anywhere else, they land in a commit. Studying a sample's _rig_ is fine: load it in its own runtime, watch how its turn reads, build our own bend to match the technique — that is observing rendered output and applying a method. Feeding its _art_ to codex-image is not: the generated character then carries that character's design. Hiyori's per-character terms forbid that — no changes of any kind to the design — and the Free Material Agreement counts it as 流用, diverting the material into models made with third-party software. `.gitignore` stops distribution, not derivation. The plugin ships the **skill and its prompts** — no art.

## What this skill does NOT change

No engine or format changes — this is prompts and procedure. The composer and the geometry checks ship in `@ikijs/mcp` (`compose_layers_from_parts`, `measure_layers`) beside the capability that already shipped in earlier slices (`auto_rig_from_layers`, the role table, blink-fold/gaze/brow rigging); the plugin pins that server at `^0.6.0` in `.mcp.json` (the nose cut and the nose-keyed parallax need 0.6) and calls the tools. No changeset — the plugin is not an npm package.
