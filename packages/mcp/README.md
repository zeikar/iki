# @iki/mcp

A stdio [MCP](https://modelcontextprotocol.io/) server that exposes `.iki` model tools to AI agents (Claude, LLMs, and any MCP-compatible client): read/validate a model, and auto-rig one from role-named PNG layers.

## Tools

| Tool                       | Description                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `validate_iki`             | Validate a raw `.iki` model — accepts an object or a JSON string — fail-fast, one error at a time.     |
| `describe_iki`             | Return a structured summary of a valid model's canvas, parameters, parts, and deformers.               |
| `list_standard_parameters` | List the recommended standard parameter ids (e.g. `ParamAngleX`, `ParamMouthOpenY`) with descriptions. |
| `auto_rig_from_layers`     | Auto-rig role-named PNG layers into a renderable `.iki` written to disk; returns the output path.      |

The `model` input for `validate_iki` and `describe_iki` accepts either a plain JSON object or a JSON string — the server normalises both.

### `auto_rig_from_layers`

Turns a set of role-named, full-canvas transparent PNG layers into a renderable, validated `.iki` model with the textures atlased and embedded as a base64 `data:image/png` URI.

- **`layers`** — array of `{ path, fileName? }`. `path` is a PNG file path (resolved against the server's working directory); the role is derived from `fileName ?? basename(path)`. Required roles: `face`, `eye_L`, `eye_R`, `mouth`. Optional roles include `iris_L`/`iris_R`, `brow_L`/`brow_R`, `hair_front`/`hair_back`, `lash_L`/`lash_R`, etc. All layers must share the same canvas size (taken from the first layer).
- **`outputPath`** — optional `.iki` output path (resolved against the working directory; the parent directory must already exist, and the path must end in `.iki`). Defaults to `auto-rigged-model.iki`.
- **Result** — on success the result text is the written file path and `structuredContent` carries `{ ok: true, path, canvas, partCount, atlasBytes }`. The (potentially multi-MB) model is written to disk, not inlined. Invalid input (unknown/missing role, empty layer, mismatched sizes, bad path, oversized atlas) returns `{ ok: false, error }` with a `INVALID: …` text — not a protocol error.

The decode/atlas pipeline runs in Node via `sharp` (a native dependency confined to this package); it mirrors the browser editor's import flow and reuses the pure `@iki/editor-core` model + atlas math, so both paths produce the same rig.

## Usage

Run directly with npx (no install needed):

```bash
npx -y @iki/mcp
```

Or install globally and use the `iki-mcp` bin:

```bash
npm install -g @iki/mcp
iki-mcp
```

## Claude Desktop / Claude Code config

Add to your MCP server config:

```json
{ "mcpServers": { "iki": { "command": "npx", "args": ["-y", "@iki/mcp"] } } }
```

For Claude Desktop this goes in `claude_desktop_config.json`; for Claude Code it goes in `.claude/mcp.json` (or the equivalent per-project config).

## Scope note

Current tools cover read/validate plus auto-rigging a model from PNG layers (`auto_rig_from_layers`). PSD input and granular model-mutation primitives (add part, bind parameter, export) are deferred to future slices.

## License

MIT © Zeikar
