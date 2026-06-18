---
name: iki-character
description: Generate a renderable, auto-rigged Iki character (`.iki`) from one gesture — drive codex-image to draw role-separated transparent part PNGs (eyeless face base, sclera, iris, mouth, lash, brow, front hair), compose them into canvas-aligned role layers with the bundled `compose.cjs`, then call the `auto_rig_from_layers` MCP tool to emit a rigged `.iki` that blinks, gazes, opens its mouth, turns its head, and emotes with its brows. Use whenever the user asks to "make/generate/create an Iki character" from scratch (no existing art).
---

# Iki Character (gen-AI → compose → auto-rig)

Turn "make me a character" into a renderable, animated `.iki` in one autonomous chain. This is the **skills** leg of the Iki north star ("good models FAST via gen-AI + MCP + skills") — the gen-AI leg (codex-image) and the MCP leg (`auto_rig_from_layers`) already exist; this skill binds them with a committed deterministic composer so the whole pipeline is reproducible (no `/tmp` scratch dependency).

```
codex-image (role-separated part PNGs)  →  compose.cjs (canvas role layers)  →  auto_rig_from_layers (MCP)  →  rigged .iki  →  render-verify
```

The hard part is **getting clean role-separated parts out of codex-image** (an eyeless face base, an iris-free white sclera) and **composer determinism** — most of this file is the hard-won prompt patterns and pitfalls that make that reliable.

## When to use

- The user asks to generate/create/make an Iki character, avatar, or model **from scratch** (there is no existing art to import).
- You want to demo the full gen-AI → rig pipeline end to end.

## When NOT to use

- The user already has layered art (PNG layers or a PSD) → use the editor's "Import layer set" / PSD import path (`examples/editor`), not generation.
- The user wants engine/format/rig _capability_ work (new deformer, new role, blink mechanics) → that's a normal code slice, not this skill.
- The user wants to tweak an existing `.iki`'s parameters/poses → drive the playground (`iki-visual-test`), don't regenerate.

## Prerequisites

- **codex-image skill** available (it shells out to `codex exec` with the built-in `image_generation` tool; **billed, takes minutes**, supports background-parallel generation). Confirm the user is OK spending on generation before starting.
- **`sharp`** resolvable for `compose.cjs`. It is not a repo dependency (sharp is confined to `@iki/mcp`). Run the composer from a scratch dir with sharp installed, e.g.:
  ```bash
  mkdir -p /tmp/iki-char/parts && cd /tmp/iki-char && npm i sharp --silent
  ```
  (or reuse `packages/mcp/node_modules` via `NODE_PATH`).
- **`auto_rig_from_layers` MCP tool** reachable. Two ways:
  - The user has the **iki MCP server configured** (a `mcp__*__auto_rig_from_layers` tool is available) — call it directly.
  - Local dev with the server **not** registered: build and drive the **bin** over stdio:
    ```bash
    pnpm --filter @iki/mcp build   # produces packages/mcp/dist/cli.js
    ```
    then send a JSON-RPC `tools/call` to `node packages/mcp/dist/cli.js` (see Step 3). The tool **confines the output `.iki` to the process cwd** (realpath + atomic rename), so launch the bin from the dir you want the model written under.

## The role set this skill generates (full-expression default)

Mirrors `@iki/editor-core` `ROLE_TABLE` / `REQUIRED_ROLES`. **Required:** `face`, `eye_L`, `eye_R`, `mouth`. The composer additionally emits `iris_L/R` (gaze), `lash_L/R` (blink-fold cover), `brow_L/R` (expression), `hair_front`. That set gives a character that **blinks (eyelid-fold), gazes, opens/forms its mouth, turns its head, and raises/tilts its brows**.

| codex-image part                                         | composer output role(s)                              | drives                                                           |
| -------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| `face.png` (NO eyes, NO mouth)                           | `face`                                               | head-turn warp, breath                                           |
| `mouth.png` (closed)                                     | `mouth`                                              | MouthOpen / MouthForm                                            |
| `eyewhite.png` (white almond + dark lashes, **NO iris**) | `eye_L/R` (split sclera) + `lash_L/R` (split lashes) | blink-fold (sclera = clip mask + fold; lash folds over the seam) |
| `iris.png` (colored disc + pupil + highlight)            | `iris_L/R`                                           | gaze (EyeballX/Y), auto-clipped to the sclera                    |
| `brow.png` (one eyebrow)                                 | `brow_L/R` (mirrored)                                | BrowY / BrowAngle                                                |
| `hair_front.png` (bangs)                                 | `hair_front`                                         | rides the face warp on head-turn                                 |

`eye_L/R` and `lash_L/R` both come from the **single** `eyewhite.png` — `compose.cjs prepEyeSplit()` splits it by luminance into a clean white sclera (lashes recolored white = the clip-mask shape) and a dark lash-only layer. This is deliberate: asking codex-image for a _separately clean_ sclera and lash is less reliable than splitting one lashed white deterministically.

## Procedure

### Step 1 — Generate role-separated parts with codex-image

Invoke the **codex-image** skill to generate the parts **in parallel** into a parts dir (e.g. `/tmp/iki-char/parts/`). Keep a **shared style descriptor** in every prompt so the parts read as one character (same hair color, eye color, line weight, flat anime cel-shading). Demand a **transparent background, front-facing, centered** part. (If a part comes back opaque-on-white instead of transparent, the composer's `keyWhiteToAlpha` fallback keys near-white to alpha — but transparent is better.)

Prompt skeleton (fill `<STYLE>` consistently, e.g. "flat anime cel-shaded, soft lavender hair, blue eyes, clean line art"):

- **face.png** — "Front-facing anime character face base, `<STYLE>`. Skin, ears, neck, face shape only. **NO eyes, NO eyebrows, NO mouth, NO hair** — bare skin where features go. Transparent background, centered."
- **mouth.png** — "A single small closed anime mouth / lips, `<STYLE>`. Transparent background, centered, nothing else."
- **eyewhite.png** — "A single anime eye, `<STYLE>`: an almond-shaped **white sclera** with **dark upper eyelashes** along the top. **NO iris, NO pupil, NO colored disc** — just the white interior and the dark lash line. Transparent background, one eye only." _(The "NO iris" negation is the flaky part — see Pitfalls. Generate 2–3 variants and pick the cleanest iris-free one.)_
- **iris.png** — "A single round anime iris disc, `<STYLE>` eye color: radial colored iris with a dark round pupil and a small white highlight glint, top. Transparent background, just the disc, no eyelid, no sclera, no lashes."
- **brow.png** — "A single anime eyebrow, `<STYLE>`. Transparent background, one brow only, gentle arch."
- **hair_front.png** — "Front hair / bangs for an anime character, `<STYLE>`, framing an empty face from above. Transparent background, front layer only (no back hair, no face)."

Save each to the parts dir with the **exact filenames above** (`compose.cjs` expects them).

### Step 2 — Compose into canvas role layers

Run the bundled composer (it lives next to this file):

```bash
node /Users/.../.claude/skills/iki-character/compose.cjs <partsDir> <layersDir>
# e.g. node .../compose.cjs /tmp/iki-char/parts /tmp/iki-char/layers
```

It alpha-trims, resizes, mirrors L/R, and pastes each part at its `LAYOUT` center on a shared 1000×1000 transparent canvas, then writes role-named PNGs (`face.png`, `eye_L.png`, …) + a flattened `preview.png` to `<layersDir>`.

**Read `preview.png`** to check alignment. The default `LAYOUT` assumes the standard framing prompted above; if eyes/mouth/brows are off, **edit the `LAYOUT` block at the top of `compose.cjs`** (cx/cy/w per role) and re-run. Composing is pure/deterministic and **does not** re-bill — iterate freely. Keep `iris` width smaller than the sclera opening so it sits inside before runtime clipping.

### Step 3 — Auto-rig to a renderable `.iki` via MCP

Call `auto_rig_from_layers` with the canvas role layers (full PNG paths) and an output path **under the launch cwd** ending in `.iki`. Input shape:

```jsonc
{
  "layers": [
    { "path": "/tmp/iki-char/layers/face.png" },
    { "path": "/tmp/iki-char/layers/eye_L.png" },
    { "path": "/tmp/iki-char/layers/eye_R.png" },
    { "path": "/tmp/iki-char/layers/iris_L.png" },
    { "path": "/tmp/iki-char/layers/iris_R.png" },
    { "path": "/tmp/iki-char/layers/lash_L.png" },
    { "path": "/tmp/iki-char/layers/lash_R.png" },
    { "path": "/tmp/iki-char/layers/mouth.png" },
    { "path": "/tmp/iki-char/layers/brow_L.png" },
    { "path": "/tmp/iki-char/layers/brow_R.png" },
    { "path": "/tmp/iki-char/layers/hair_front.png" },
  ],
  "outputPath": "iki-character.iki",
}
```

Role is derived from the file basename (override per layer with `fileName` if needed). The tool decodes/crops/atlases itself (sharp, internal) and writes a renderable `.iki`, returning its path. A missing required role or a layer whose size ≠ the canvas comes back as `{ ok: false, error }` — fix the layers and retry.

Driving the **bin** over stdio when the server isn't registered (run from the dir you want the `.iki` in):

```bash
cd /tmp/iki-char
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"auto_rig_from_layers","arguments":{"layers":[...],"outputPath":"iki-character.iki"}}}' \
  | node /Users/.../packages/mcp/dist/cli.js
```

### Step 4 — Render-verify

Load the `.iki` in the playground and confirm it renders + animates. Use the **iki-visual-test** skill: `pnpm playground`, then `window.__iki.load(<model>)` (fetch the disk `.iki` via vite `/@fs/<abs-path>`), drive `ParamEyeLOpen`/`ParamEyeROpen` (blink-fold), `ParamEyeBallX/Y` (gaze), `ParamMouthOpenY`/`ParamMouthForm`, `ParamAngleX` (head turn), `ParamBrowLY`/`RY`/`LAngle`/`RAngle` (expression), and screenshot before/after. A clean console (no `IkiFormatError`/WebGL error) plus visibly-driving parameters = success.

## Pitfalls (hard-won — read before generating)

- **"NO iris" on the eyewhite is the flakiest prompt.** codex-image often paints an iris anyway. Generate **2–3 eyewhite variants** and pick the cleanest iris-free one; a leaked colored iris breaks `prepEyeSplit` (the luminance split would misclassify a dark/saturated iris as lash). If all variants leak, regenerate with a stronger negation ("empty white interior, absolutely no colored circle").
- **The face base must have NO eyes and NO mouth.** A face with baked eyes can't blink/gaze (the eye stack would double up). Re-prompt until the eye/mouth sockets are bare skin.
- **Keep the iris smaller than the sclera opening** in `LAYOUT` (default `w:48`). The auto-rig auto-clips iris→sclera at runtime, but an oversized iris looks wrong before the clip and at extreme gaze.
- **Opaque-on-white parts** are handled by `keyWhiteToAlpha` (keys >238 RGB to alpha), but transparent output is cleaner — ask for it. White-rimmed parts (e.g. a white highlight on the iris) can be clipped by the key; prefer transparent generation for those.
- **MCP output is cwd-confined.** `auto_rig_from_layers` rejects an `outputPath` that escapes the launch cwd (must end in `.iki`, realpath-checked, atomic rename). Launch the bin from where you want the file.
- **Style drift across parts.** Independent generations can mismatch hue/line-weight. Keep one `<STYLE>` string identical across all six prompts; regenerate the outlier, not the whole set.
- **Composer needs `sharp`, which is not a repo dep.** Don't `pnpm add sharp` to a workspace package — install it ad hoc in the scratch dir (or use `@iki/mcp`'s copy). sharp stays confined to `@iki/mcp` in the repo.
- **Don't commit generated character art or reference models.** Generated PNGs and any reference model (e.g. Hiyori) are scratch/gitignored — keep them out of the repo. This slice ships the **skill + composer only**.

## What this skill does NOT change

No `@iki/*` source changes — this is a skill + a standalone composer script. No changeset. The capability (`auto_rig_from_layers`, the role table, blink-fold/gaze/brow rigging) already shipped in earlier slices; this skill only orchestrates them.
