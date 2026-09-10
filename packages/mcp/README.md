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

The `model` input for `validate_iki` and `describe_iki` accepts either a plain JSON object or a JSON string — the server normalises both.

### `auto_rig_from_layers`

Turns a set of role-named, full-canvas transparent PNG layers into a renderable, validated `.iki` model with the textures atlased and embedded as a base64 `data:image/png` URI.

- **`layers`** — array of `{ path, fileName? }`. `path` is a PNG file path (resolved against the server's working directory); the role is derived from `fileName ?? basename(path)`. Required roles: `face`, `eye_L`, `eye_R`, `mouth`. Optional roles include `iris_L`/`iris_R`, `brow_L`/`brow_R`, `hair_front`/`hair_back`, `lash_L`/`lash_R`, etc. All layers must share the same canvas size (taken from the first layer).
- **`outputPath`** — optional `.iki` output path (resolved against the working directory; the parent directory must already exist, and the path must end in `.iki`). Defaults to `auto-rigged-model.iki`.
- **Result** — on success the result text is the written file path and `structuredContent` carries `{ ok: true, path, canvas, partCount, atlasBytes }`. The (potentially multi-MB) model is written to disk, not inlined. Invalid input (unknown/missing role, empty layer, mismatched sizes, bad path, oversized atlas) returns `{ ok: false, error }` with a `INVALID: …` text — not a protocol error.

The decode/atlas pipeline runs in Node via `sharp` (a native dependency confined to this package); it mirrors the browser editor app's import flow and reuses the pure `@ikijs/editor` model + atlas math, so both paths produce the same rig.

### `compose_layers_from_parts`

Composes a directory of AI-generated part PNGs into canvas-aligned, role-named layer PNGs ready for `auto_rig_from_layers`, on a fixed 1100×1100 canvas with a built-in default layout tuned for the character-generation skill's standard front-facing framing. It ports the composer that shipped as a script (`compose.cjs`) in the Claude Code plugin.

- **`partsDir`** — directory of the source part PNGs (resolved against the server's working directory). Required sources: `face.png`, `eyewhite.png` (split into the sclera + lash layers), `iris.png`, `mouth.png`, `brow.png`, `hair_front.png`. Optional: `hair_back.png`, `body.png`, `mouth_open.png` — a parts dir without them still composes, minus those roles.
- **`outDir`** — an existing directory (resolved against the working directory, confined to it exactly like `auto_rig_from_layers`'s `outputPath`; the tool never creates directories) to write the role layer PNGs and a flattened `preview.png` into. Reusing a directory across runs is intentional — a role this run skips (e.g. composing a head-only set that omits `body`) has its stale `<role>.png` from an earlier run deleted, so the directory always holds exactly this run's roles.
- **`layout`** — optional per-role override merged over the built-in defaults, e.g. `{ "eye_L": { "cx": 660 } }`, so a character can be retuned by re-running compose rather than editing a script. Each of `cx`, `cy`, `w`, `h` is optional; `w` and `h` must be integers in 1..1100 (the canvas size). Omitting `h` keeps the part's own aspect ratio, which is what every role wants until one does not: a generated eyewhite often comes back flatter than its reference, and stretching a flat white lens costs nothing where regenerating it is billed and unreliable. Set `h` on a sclera and its lash together — they share one frame, and the blink fold tears if they diverge.
- **Result** — on success the text is the written layer paths (one per line) followed by the same geometry report `measure_layers` returns; `structuredContent` is `{ ok: true, outDir, layers, skipped, preview, measure }`. Invalid input (a missing required part, an unknown `layout` role, an out-of-range `w` or `h`, a part that lands entirely off-canvas, a non-existent `outDir`) returns `{ ok: false, error }` with `INVALID: …` text.

### `measure_layers`

Reports the same read-only geometry checks `compose_layers_from_parts` returns inline (iris size/offset relative to the sclera, eye aspect, cropped or flat-cut edges, missing optional roles), over an already-composed layers directory — for re-checking a layers dir without recomposing it.

- **`layersDir`** — directory of role-named layer PNGs (resolved against the working directory).
- **Result** — the text is the report: a per-layer size/bbox-centre/mass-centre/margins table, then the checks that fired. `structuredContent` is `{ ok: true, layersDir, layers, empty, warnings, passed }`. A missing or non-directory `layersDir` returns `{ ok: false, error }` with `INVALID: …` text.

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

Current tools cover read/validate, auto-rigging a model from PNG layers (`auto_rig_from_layers`), and composing/measuring the role layers a generated character needs (`compose_layers_from_parts`, `measure_layers`). PSD input and granular model-mutation primitives (add part, bind parameter, export) are deferred to future slices.

## License

MIT © Zeikar
