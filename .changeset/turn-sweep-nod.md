---
"@ikijs/mcp": minor
---

`render_poses` gains `sweeps`: more sweeps in one call, with the new `turn-nod` preset (the box through every `ParamAngleX` × `ParamAngleY` stop, its by-angle sheet, no kymograph). The sweep `manifest.json` is now version 2 (per-frame `values` for several parameters, `theta` dropped), a reused sweep dir's earlier files are cleared before a run, and every sweep object carries `nod` with the report-only `SWEEP nod` / `SWEEP corner` lines. `sweep` is unchanged on the wire; a server before this version strips `sweeps`.
