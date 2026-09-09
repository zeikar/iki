---
"@ikijs/mcp": minor
---

Add two MCP tools ported from scripts (`compose.cjs`, `measure.cjs`) that shipped in the Claude Code plugin's character-generation skill. `compose_layers_from_parts` composes a directory of generated part PNGs into canvas-aligned, role-named PNG layers ready for `auto_rig_from_layers`, with a per-role `layout` override standing in for hand-editing the script, and returns the same geometry report inline. `measure_layers` re-runs that report standalone over an already-composed layers directory.
