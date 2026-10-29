---
"@ikijs/mcp": minor
---

`list_standard_parameters` gains `ParamHairBackSway`. Models rigged with both hair layers declare it and a third `hairBack` spring, so `auto_rig_from_layers` and `render_poses` print three `PHYSICS` lines, and the front springs drive the front hair only.

Rigged models swing the hair wider (tip travel 0.08 → 0.24 hh) with firmer springs (ζ 0.40), so `render_poses` and `auto_rig_from_layers` report larger `PHYSICS` displacements.
