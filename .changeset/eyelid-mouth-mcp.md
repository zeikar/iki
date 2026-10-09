---
"@ikijs/mcp": minor
---

`auto_rig_from_layers` accepts a layer set with the lip set (`mouth_inner`, `lip_lower`, `lip_upper`) in place of `mouth`, and rigs it through the new `@ikijs/editor` so the mouth folds open like the eyelid. It refuses a partial lip set and a lip set mixed with `mouth` or `mouth_open`; the tool description says so. `compose_layers_from_parts` does not emit the lip set yet.
