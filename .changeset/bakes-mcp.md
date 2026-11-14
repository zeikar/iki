---
"@ikijs/mcp": minor
---

`auto_rig_from_layers` takes `bakes`, lattices that move the custom parts when a parameter does (`RigBakes` in `@ikijs/editor`: `targets`, optional `meshes`), and `customParts[i].rigid`. A stop is the part's total landed displacement in canvas px, so a neighbour's displacement as `probe_rig` measures it is written as it is; the motion is linear between stops and holds past the outermost. Before the file is written the rig is landed through the engine at every stop and compared with what the generator was asked for: a stop off by 0.1 px or more is `INVALID: BAKE ERROR <part> <param>=<value>: …` and nothing is written, as is any `bakes…` input the rig refuses. Otherwise one `BAKE <part> <param>: <n> vertices, stops …, error <max> px` line per part and parameter follows the `CUSTOM` lines, and the result's `customParts.bakes` carries the same numbers. A rig with `customParts` and no `bakes` writes the same file as before.
