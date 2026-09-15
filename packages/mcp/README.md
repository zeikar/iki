# @ikijs/mcp

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

Turns a set of role-named, full-canvas transparent PNG layers into a renderable, validated `.iki` model with the textures atlased and embedded as a base64 `data:image/png` URI.

- **`layers`** — array of `{ path, fileName? }`. `path` is a PNG file path (resolved against the server's working directory); the role is derived from `fileName ?? basename(path)`. Required roles: `face`, `eye_L`, `eye_R`, `mouth`. Optional roles include `iris_L`/`iris_R`, `brow_L`/`brow_R`, `hair_front`/`hair_back`, `lash_L`/`lash_R`, etc. All layers must share the same canvas size (taken from the first layer).
- **`outputPath`** — optional `.iki` output path (resolved against the working directory; the parent directory must already exist, and the path must end in `.iki`). Defaults to `auto-rigged-model.iki`.
- **`turnTargets`** — optional head-turn cues to fit the rig to, in the units `measure_turn_reference` reports off a front/turned reference pair: `eyeShift` (plus `noseShift` and `mouthShift`, derived from it when absent) is how far that feature slides across the head at full turn, as a fraction of the head's half-width — a **magnitude**, since the rig turns both ways and the sign is the turn's own business; `farEyeRatio` is the far/near eye width at full turn over that same ratio at rest; `silhouetteRatio` the head's half-width turned over at rest. An omitted field falls back to a built-in default, which is _clamped_ to what the layer set can do; a target you **do** pass that it cannot reach is refused, because that number is a measurement rather than a preference. Only a layer set carrying a `nose` solves a turn at all.
- **Result** — on success the result text is the written file path and `structuredContent` carries `{ ok: true, path, canvas, partCount, atlasBytes, headHalfWidth?, headHalfWidthApplied, headEdges?, turn? }`. `headHalfWidth` is the head measured here rather than asked for: the layers' own opaque union at the eye row, under the same `alpha >= 128` rule and ±10-row band `measure_turn_reference` spans a render with, so the rig's own rest render measures that span back; it is **absent** when that union has no span there at all (translucent art painted below alpha 128 — still a valid layer set, just with nothing to measure). `headHalfWidthApplied` is `false` when the measured value is absent, or no wider than the face plate (a hairless set, or one widest at the plate itself) — the generator will not take such a head, so the plate stands in for it and the rig is still produced either way. `headEdges` is a companion to a measured, applied `headHalfWidth` (absent otherwise): every role with an opaque pixel in that same eye-row band, per side, each with its own rest x there — passed straight to the generator's own `options.headEdges` so it can tell which part's own deformation actually carries the union's outermost pixel through the turn. `turn` is what the solve settled on — `{ radius, holdBase, depths, achieved: { eyeShift, farEyeRatio, silhouetteRatio }, clamped }`, where `clamped` names the _defaulted_ targets this layer set could not reach and `achieved` is what the rig does reach; it is absent without a `nose` layer. The (potentially multi-MB) model is written to disk, not inlined. Invalid input (unknown/missing role, empty layer, mismatched sizes, bad path, oversized atlas, a `turnTargets` field that is not a number or that this layer set cannot reach — the message names the field and the attainable range) returns `{ ok: false, error }` with a `INVALID: …` text — not a protocol error.

The decode/atlas pipeline runs in Node via `sharp` (a native dependency confined to this package); it mirrors the browser editor app's import flow and reuses the pure `@ikijs/editor` model + atlas math, so both paths produce the same rig.

### `compose_layers_from_parts`

Composes a directory of AI-generated part PNGs into canvas-aligned, role-named layer PNGs ready for `auto_rig_from_layers`, on a fixed 1100×1100 canvas with a built-in default layout tuned for the character-generation skill's standard front-facing framing. It ports the composer that shipped as a script (`compose.cjs`) in the Claude Code plugin.

- **`partsDir`** — directory of the source part PNGs (resolved against the server's working directory). Required sources: `face.png`, `eyewhite.png` (split into the sclera + lash layers), `iris.png`, `mouth.png`, `brow.png`, `hair_front.png`. Optional: `hair_back.png`, `body.png`, `mouth_open.png`, `nose.png` — a parts dir without them still composes, minus those roles. The nose is what the auto-rig leads the head turn with (without a `nose` layer nothing on the face slides), and a face supplied alongside it must be drawn without one, or the painted nose stays on the face plate while the real one moves.
- **`outDir`** — an existing directory (resolved against the working directory, confined to it exactly like `auto_rig_from_layers`'s `outputPath`; the tool never creates directories) to write the role layer PNGs and a flattened `preview.png` into. Reusing a directory across runs is intentional — a role this run skips (e.g. composing a head-only set that omits `body`) has its stale `<role>.png` from an earlier run deleted, so the directory always holds exactly this run's roles.
- **`layout`** — optional per-role override merged over the built-in defaults, e.g. `{ "eye_L": { "cx": 660 } }`, so a character can be retuned by re-running compose rather than editing a script. Each of `cx`, `cy`, `w`, `h` is optional; `w` and `h` must be integers in 1..1100 (the canvas size). Omitting `h` keeps the part's own aspect ratio, which is what every role wants until one does not: a generated eyewhite often comes back flatter than its reference, and stretching a flat white lens costs nothing where regenerating it is billed and unreliable. Set `h` on a sclera and its lash together — they share one frame, and the blink fold tears if they diverge.
- **Result** — on success the text is the written layer paths (one per line) followed by the same geometry report `measure_layers` returns; `structuredContent` is `{ ok: true, outDir, layers, skipped, preview, measure }`. Invalid input (a missing required part, an unknown `layout` role, an out-of-range `w` or `h`, a part that lands entirely off-canvas, a non-existent `outDir`) returns `{ ok: false, error }` with `INVALID: …` text.

### `measure_layers`

Reports the same read-only geometry checks `compose_layers_from_parts` returns inline (iris size/offset relative to the sclera, eye aspect, cropped or flat-cut edges, missing optional roles), over an already-composed layers directory — for re-checking a layers dir without recomposing it.

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
