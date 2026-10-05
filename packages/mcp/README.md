# @ikijs/mcp

> Part of [Iki](https://github.com/zeikar/iki), the open Live2D alternative that AI can build — free and MIT-licensed, with an open `.iki` format and a [Claude Code plugin](https://github.com/zeikar/iki/tree/main/plugin) that draws and rigs characters.

A stdio [MCP](https://modelcontextprotocol.io/) server that exposes `.iki` model tools to AI agents (Claude, LLMs, and any MCP-compatible client): read/validate a model, and auto-rig one from role-named PNG layers.

## Tools

| Tool                        | Description                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `validate_iki`              | Validate a raw `.iki` model — accepts an object or a JSON string — fail-fast, one error at a time.     |
| `describe_iki`              | Return a structured summary of a valid model's canvas, parameters, parts, and deformers.               |
| `list_standard_parameters`  | List the recommended standard parameter ids (e.g. `ParamAngleX`, `ParamMouthOpenY`) with descriptions. |
| `auto_rig_from_layers`      | Auto-rig role-named PNG layers into a renderable `.iki` written to disk; returns the output path.      |
| `compose_layers_from_parts` | Compose generated part PNGs into canvas-aligned, role-named layers, with the geometry report inline.   |
| `measure_layers`            | Re-run that same geometry report over an already-composed layers directory.                            |
| `measure_turn_reference`    | Measure how far a head turns between a front and a turned image at the same scale, as three ratios.    |

The `model` input for `validate_iki` and `describe_iki` accepts either a plain JSON object or a JSON string — the server normalises both.

### `auto_rig_from_layers`

Turns a set of role-named, full-canvas transparent PNG layers into a renderable, validated `.iki` model with the textures atlased and embedded as a base64 `data:image/png` URI. Under `quantizeColors` a `nose` layer is the exception: the palette rims a soft-shaded nose's feather, so the nose is atlased alone on a second, lossless page.

- **`layers`** — array of `{ path, fileName? }`. `path` is a PNG file path (resolved against the server's working directory); the role is derived from `fileName ?? basename(path)`. Required roles: `face`, `eye_L`, `eye_R`, `mouth`. Optional roles include `iris_L`/`iris_R`, `brow_L`/`brow_R`, `hair_front`/`hair_back`, `lash_L`/`lash_R`, `lash_lower_L`/`lash_lower_R`, etc. All layers must share the same canvas size (taken from the first layer).
- **`outputPath`** — optional `.iki` output path (resolved against the working directory; the parent directory must already exist, and the path must end in `.iki`). Defaults to `auto-rigged-model.iki`.
- **`turnTargets`** — optional head-turn cues to fit the rig to, in the units `measure_turn_reference` reports off a front/turned reference pair: `eyeShift` (plus `noseShift` and `mouthShift`) is how far that feature slides across the head at full turn, as a fraction of the head's half-width — a **magnitude**, since the rig turns both ways and the sign is the turn's own business; `farEyeRatio` is the far/near eye width at full turn over that same ratio at rest; `silhouetteRatio` the head's half-width turned over at rest. An omitted field leaves that part of the turn at the profile the rig defaults to. An `eyeShift` you pass is fitted by the turn's amount and _clamped_ when it runs past the room the art leaves the far eye — the face plate's edge, or the bangs' side strand over the far iris — since that room is a fact about these layers, not about the reference. Any other target you **do** pass that it cannot reach is refused, because that number is a measurement rather than a preference. A layer set without a `nose` still turns its head, on the profile, but fits no target: `turnTargets` is then inert and the result carries no `turn`.
- **`style`** — optional per-character tuning from the profile the rig defaults to: `turn` (the whole head turn, the eyes' foreshortening with it, 0..3, 1 = the profile; ignored when `turnTargets.eyeShift` is given), `featureLead` (how far the features lead the face plate, 0..3), `hairFollow` (the front hair's share of the face's turn, 0..2, profile 1), `outlineFollow` (its outer edge's share where it draws the head's outline, 0..2, profile 0: the outline holds), `blink` (how far the upper lid comes down over the eye's height, 0.1..1, profile 0.6) and `sway` (the hair sway amplitude, 0..5). A value out of range, or a knob not named here, is refused.
- **Result** — on success the result text is the written file path and `structuredContent` carries `{ ok: true, path, canvas, partCount, atlasBytes, headHalfWidth?, headHalfWidthApplied, headEdges?, strandEdges?, noseCore?, turn? }`. `atlasBytes` is the embedded atlas's data-URI length, summed over both pages when the nose has one of its own. `headHalfWidth` is the head measured here rather than asked for: the layers' own opaque union at the eye row, under the same `alpha >= 128` rule and ±10-row band `measure_turn_reference` spans a render with, so the rig's own rest render measures that span back; it is **absent** when that union has no span there at all (translucent art painted below alpha 128 — still a valid layer set, just with nothing to measure). `headHalfWidthApplied` is `false` when the measured value is absent, or no wider than the face plate (a hairless set, or one widest at the plate itself) — the generator will not take such a head, so the plate stands in for it and the rig is still produced either way. `headEdges` is a companion to a measured, applied `headHalfWidth` (absent otherwise): every role with an opaque pixel in that same eye-row band, per side, each with its own rest x there — passed straight to the generator's own `options.headEdges` so it can tell which part's own deformation actually carries the union's outermost pixel through the turn. `strandEdges` is each side's iris and the `hair_front` run it would slide under on the turn, measured whenever the layers include `hair_front`, `iris_L` and `iris_R`: the iris's opaque span and the run's outer and face-side ends as pixel edges on the row holding the iris's centre (a run that reaches the other iris's centre, a fringe spanning the face, has `runFace: null`; a run narrower than half the iris's painted width on that row is hair detail the iris may cross, and is skipped as if clear) — passed straight to the generator's own `options.strandEdges`, which keeps the far iris from sliding under the bangs any further than it is painted. `turn` is what the solve settled on — `{ radius, holdBase, depths, achieved: { eyeShift, farEyeRatio, silhouetteRatio }, clamped, strandOverlap? }`, where `achieved` is what the rig does reach and `clamped` names every target the rig cut down: the turn (`eyeShift`, passed or the profile's own) where the face plate's edge or the strand cut it short, and a profile `noseShift` / `mouthShift` past its room. `strandOverlap` gives, per side whose far iris the bangs still cover at some far stop, the covered width — how much of the iris's painted row the run covers where that is largest (`deg`, `px`, and `hh` in head half-widths), how much it covers at rest (`restPx`), and whether the bound held (`held`: `true` means the iris is kept no deeper under the run than it is painted; `false` means the art left no room to — always so for a fringe spanning the face — and `px` is what stays covered); it is absent when nothing is covered. `noseCore` is the nose's dense core in canvas px — its pixels at alpha >= 128, not grown, the box handed to the generator as the nose layer's `denseCore` and its turn landmark — absent without a `nose` layer, when it has no pixel at that threshold (painted wholly translucent), or when that core is a speck of the nose's crop (under a quarter of its width or height, such as a lone nostril mark), and in both of the last two cases the crop stands in for it. `turn` is absent without a `nose` layer. The (potentially multi-MB) model is written to disk, not inlined. Invalid input (unknown/missing role, empty layer, mismatched sizes, bad path, oversized atlas, a `turnTargets` field that is unknown or that this layer set cannot reach — any passed field other than an `eyeShift` past the art's room; a `style` knob out of range or unknown; the message names the field and the attainable range) returns `{ ok: false, error }` with a `INVALID: …` text — not a protocol error. An argument the tool's input schema refuses — a `turnTargets` or `style` that is not an object, or one of their named fields that is not a number — never reaches the tool: the MCP SDK answers with an `isError` result whose text is `MCP error -32602: Input validation error: …`, and no `structuredContent`.

The decode/atlas pipeline runs in Node via `sharp` (a native dependency confined to this package); it mirrors the browser editor app's import flow and reuses the pure `@ikijs/editor` model + atlas math, so both paths produce the same rig.

### `compose_layers_from_parts`

Composes a directory of AI-generated part PNGs into canvas-aligned, role-named layer PNGs ready for `auto_rig_from_layers`, on a fixed 1100×1100 canvas with a built-in default layout tuned for the character-generation skill's standard front-facing framing. It ports the composer that shipped as a script (`compose.cjs`) in the Claude Code plugin.

- **`partsDir`** — directory of the source part PNGs (resolved against the server's working directory). Required sources: `face.png`, `eyewhite.png` (split into the sclera, the upper lash and the lower lid — `lash_lower_L`/`lash_lower_R`, the dark line and lashes of the eye's lower part, which draw over the iris and are placed on the sclera's frame by the `eye_*` layout, so they have no layout key of their own; an eyewhite with no dark lower lid writes none and lists them in `skipped`. A light mark drawn detached above the eye white, such as a double-eyelid crease, is dropped from the sclera — the iris's clip — while dark strokes there stay lash ink), `iris.png`, `mouth.png`, `brow.png`, `hair_front.png`. Optional: `hair_back.png`, `body.png`, `mouth_open.png`, `blush.png`, `nose.png` — a parts dir without them still composes, minus those roles. One `blush.png` makes both cheeks' blush: `blush_R` takes it as drawn and `blush_L` mirrored. It is decoration, so the report does not flag a set without it. The nose is what the auto-rig leads the head turn with, and a face supplied alongside it must be drawn without one, or the painted nose stays on the face plate while the real one moves. Each part but the eye pair is cropped to its drawing before it is sized and placed. A faint speck detached from the drawing, one that never reaches alpha 128 and covers under 1 % of the part's pixels (residue a background removal leaves), is cut out with the margin it widened, so it cannot pull the part off its centre. A detached stroke that reaches alpha 128 is kept.
- **`outDir`** — an existing directory (resolved against the working directory, confined to it exactly like `auto_rig_from_layers`'s `outputPath`; the tool never creates directories) to write the role layer PNGs and a flattened `preview.png` into. Reusing a directory across runs is intentional — a role this run skips (e.g. composing a head-only set that omits `body`) has its stale `<role>.png` from an earlier run deleted, so the directory always holds exactly this run's roles.
- **`layout`** — optional per-role override merged over the built-in defaults, e.g. `{ "eye_L": { "cx": 660 } }`, so a character can be retuned by re-running compose rather than editing a script. Each of `cx`, `cy`, `w`, `h` is optional; `w` and `h` must be integers in 1..1100 (the canvas size). The defaults of the face's features — blush, nose, mouth, `mouth_open`, eyes, irises, lashes, brows — are proportions of the face: an override of `face.cx`, `face.cy` or `face.w` carries them with it (scaled by the width; `face.h` stretches the face alone), while a feature's own override names canvas px. Omitting `h` keeps the part's own aspect ratio, which is what every role wants until one does not: a generated eyewhite often comes back flatter than its reference, and stretching a flat white lens costs nothing where regenerating it is billed and unreliable. The nose is sized and placed by its dense core — its pixels at alpha ≥ 128, the drawing a viewer reads inside a soft nose's feather — rather than its whole part, which for a shaded-bump nose is mostly feather: `w` (default 20) and `h` size the core, `cx` (default 550) centres it, and a set `cy` centres its rows. By default its `cy` is unset, and the core's bottom row (the tip) lands 0.66 of the way from the eye row down to the mouth's, so the nose follows a retuned eye or mouth row. A nose with no pixel at alpha ≥ 128 is sized and placed whole, and so is one whose core is a speck of its trimmed part — under a quarter of its width or height, such as a lone nostril mark or highlight, which sized to `w` would blow the whole nose up — and the report warns of the speck. Set `h` on a sclera and its lash together — they share one frame, and the blink fold tears if they diverge, so a pair set to land on different frames is rejected.
- **`mirrorParts`** — optional list of part files to flip left-right as they are read, e.g. `["eyewhite.png"]`. Which way a part faces is fixed by the layout, and "left eye" cannot pin it down — it reads as the viewer's left or the character's — so in image terms: `eyewhite.png` is read as the eye on the screen left, lash wing (outer corner) at the image's left end and lash-free tear duct at its right; `brow.png` as the brow on the screen right, thick head at the image's left end and tail at its right; `blush.png` as the blush on the screen left, outer end (toward the face's edge) at the image's left end and inner end at its right. A part drawn the other way round is fixed here for free instead of regenerated. It flips the source, so every role cut from it flips together and an eye's sclera and lash stay in one frame.
- **Result** — on success the text is the written layer paths (one per line) followed by the same geometry report `measure_layers` returns — except that when the composer found the core of the nose's source part a speck, its nose check reports that verdict instead of what the composed file shows, so a speck that resampling erased from the layer is warned about here and not by `measure_layers`. `structuredContent` is `{ ok: true, outDir, layers, skipped, preview, measure }`. Invalid input (a missing required part, an unknown `layout` role, an out-of-range `w` or `h`, a lash placed on a different frame from its sclera's, a `mirrorParts` entry that is not a part file, a part that lands entirely off-canvas, a non-existent `outDir`) returns `{ ok: false, error }` with `INVALID: …` text.

### `measure_layers`

Reports the same read-only geometry checks `compose_layers_from_parts` returns inline (iris size/offset relative to the sclera, eye aspect, an eye drawn facing the other way, cropped or flat-cut edges, a nose whose dense core is a speck of its crop, missing optional roles), over an already-composed layers directory — for re-checking a layers dir without recomposing it. Its nose check reads the composed file against its crop, which is what `auto_rig_from_layers` acts on: a speck core there is one the rig does not turn or tilt the nose about. The composer's inline report does the same unless it found the source part's core a speck, which it reports instead, so a speck that resampling erased from the layer shows there and not here.

- **`layersDir`** — directory of role-named layer PNGs (resolved against the working directory).
- **Result** — the text is the report: a per-layer size/bbox-centre/mass-centre/margins table, then the checks that fired. `structuredContent` is `{ ok: true, layersDir, layers, empty, warnings, passed }`. A missing or non-directory `layersDir` returns `{ ok: false, error }` with `INVALID: …` text.

### `measure_turn_reference`

Measures how far a head turns between two images of the same character — one facing front, one turned — and reports it as three ratios, so a rigged turn can be compared against a reference turn (or against an earlier rig) without registering the two images. Every number is a front→turned _change_ divided by something measured in the same image, which cancels crop and position — **not scale**: the pair must already share framing and head size. A yaw never changes iris height, so that is what is checked — a pair whose mean iris height differs by more than 10% is refused rather than measured as if it were a turn.

- **`front`**, **`turned`** — PNG file paths (resolved against the server's working directory). Engine renders (transparent backdrop) and opaque reference art both work; see the two foreground modes below.
- **`iris`** — optional colour-window override merged over the violet default (`hueMin` 230, `hueMax` 300 degrees, `satMin` 0.22). The iris is found as a saturated blob inside that hue window, closed and paired on one row, so a character whose eyes are another colour needs its own window — otherwise the tool returns `no iris pair found …` naming the file and how many candidate blobs it had.
- **`debugDir`** — optional existing directory (confined to the working directory, like every other write) to drop a `front-<name>.debug.png` and a `turned-<name>.debug.png` into (role-prefixed, so two inputs that share a basename do not overwrite each other), with the iris boxes, the head edges, the head centre and the eye-pair centre drawn on them. The measurement is only believable once those boxes are seen sitting on the irises.
- **Result** — `structuredContent` is `{ ok: true, front, turned, farEyeRatio, eyeShift, silhouetteRatio, turnSign, debug? }`, with `front`/`turned` carrying the raw per-image numbers (iris widths and centres, eye row, head span, which foreground mode was used). A missing file, a missing `debugDir`, an image with no iris pair, or a pair whose mean iris heights differ by more than 10% (not at the same scale) returns `{ ok: false, error }` with `INVALID: …` text.

The three ratios:

| Ratio             | What it is                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `farEyeRatio`     | Turned far/near iris width, divided by that same far/near ratio at rest — so a resting asymmetry in the art divides out.               |
| `eyeShift`        | How far the eye pair slides across the head, in units of the **front** head half-width (`hh`). **Negative = toward the image's left.** |
| `silhouetteRatio` | Head half-width, turned over front.                                                                                                    |

`turnSign` is `-1` when the pair moved toward the image's left and `+1` when it moved right; the "far" eye is the one on the side it moved toward.

The head span is the silhouette at the eye row, over a ±10-row band — fixed rather than scaled to the image, so compare renders at like resolutions. The foreground it spans is found two ways, chosen per image:

- **alpha** — the file has an alpha channel with transparent pixels (an engine render): foreground is `alpha >= 128` and nothing else, so the character's near-black hair ink and pale highlights all count.
- **keyed** — a fully opaque image (a reference): the flat lavender-grey backdrop (hue 220–260, low saturation, bright) and near-black frame borders are keyed out by colour instead.

The two rules do not agree on the same picture — a near-black outline is silhouette under `alpha` and background under `keyed` — so compare renders with renders and references with references.

## Usage

Run directly with npx (no install needed):

```bash
npx -y @ikijs/mcp
```

Or install globally and use the `iki-mcp` bin:

```bash
npm install -g @ikijs/mcp
iki-mcp
```

## Claude Desktop / Claude Code config

Add to your MCP server config:

```json
{ "mcpServers": { "iki": { "command": "npx", "args": ["-y", "@ikijs/mcp"] } } }
```

For Claude Desktop this goes in `claude_desktop_config.json`; for Claude Code it goes in `.claude/mcp.json` (or the equivalent per-project config).

## Scope note

Current tools cover read/validate, auto-rigging a model from PNG layers (`auto_rig_from_layers`), composing/measuring the role layers a generated character needs (`compose_layers_from_parts`, `measure_layers`), and measuring a rendered head turn against a reference one (`measure_turn_reference`). PSD input and granular model-mutation primitives (add part, bind parameter, export) are deferred to future slices.

## License

MIT © Zeikar
