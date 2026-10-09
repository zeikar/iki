---
"@ikijs/editor": minor
---

Exports `mouthOpening`, `mouthFold`, `columnRuns`, `LIP_ROLES`, `LipRole`, `Opening` and `OpeningColumn`, so the composer's preview and `measure_layers` in `@ikijs/mcp` read the lip set's opening with the rig's own reader instead of a copy. There is no rig change: every layer set rigs exactly as before.
