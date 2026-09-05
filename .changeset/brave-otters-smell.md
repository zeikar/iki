---
"@ikijs/format": patch
"@ikijs/engine": patch
"@ikijs/editor": patch
"@ikijs/mcp": patch
---

Add `keywords` and widen the npm descriptions.

All four packages shipped with no `keywords` at all — the field npm search ranks
on — so none of them was reachable by the words people actually type. The root
manifest had a good keyword list but it is `private: true` and never reaches the
registry.

The descriptions leaned on `.iki`, a name nobody is searching for yet, so each
now also says what the thing is in terms that are searched: 2D puppet models,
Live2D-style rigs, VTuber avatar animation, MCP for AI agents.

Metadata only — no code, no API and no `.iki` contract change.
