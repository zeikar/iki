---
"@ikijs/mcp": minor
---

`list_standard_parameters` gains `ParamHairBackSway`. Models rigged with both hair layers declare it and a third `hairBack` spring, so `auto_rig_from_layers` and `render_poses` print three `PHYSICS` lines, and the front springs drive the front hair only.
