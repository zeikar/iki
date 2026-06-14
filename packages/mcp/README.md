# @iki/mcp

A stdio [MCP](https://modelcontextprotocol.io/) server that exposes `.iki` model read/validate tools to AI agents (Claude, LLMs, and any MCP-compatible client).

## Tools

| Tool                       | Description                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `validate_iki`             | Validate a raw `.iki` model — accepts an object or a JSON string — fail-fast, one error at a time.     |
| `describe_iki`             | Return a structured summary of a valid model's canvas, parameters, parts, and deformers.               |
| `list_standard_parameters` | List the recommended standard parameter ids (e.g. `ParamAngleX`, `ParamMouthOpenY`) with descriptions. |

The `model` input for `validate_iki` and `describe_iki` accepts either a plain JSON object or a JSON string — the server normalises both.

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

Slice 1 covers read/validate only. Tools that create or transform `.iki` models are deferred to a future slice.

## License

MIT © Zeikar
