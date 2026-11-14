---
"@ikijs/mcp": minor
---

`auto_rig_from_layers` takes `occlusion` on a `customParts` entry (`{ by, parameter, stops }`, `by` as roles of the set) and reports it: the result's part carries it, and its `CUSTOM <id>:` line ends with what hides it. `render_poses`'s `hideParts` refuses a part that a part which stays names in its `occlusion.by`, as it does a clip mask. An older server refuses the key as an unknown key.
