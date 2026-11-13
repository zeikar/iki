---
"@ikijs/mcp": minor
---

New tool `probe_rig` measures a rigged `.iki` without rendering it, through the engine's `landParts`. A query is `{ op: "land" | "displacement", part, points, pose? }`, where each canvas-px point of a part lands in a pose (a point outside the part's mesh is `null`; unnamed parameters stay at their defaults and a value is clamped to its range), or `{ op: "paint", path }`, the opaque runs per canvas row of a canvas-sized layer PNG, read from the file and not the atlas. `outputPath` (a `.probe.json` under the working directory) writes the results to a file and returns a line per query. A refusal is `INVALID: queries[i].<field> …`. `resolveOutputPath` takes the extension it requires, `.iki` by default.
