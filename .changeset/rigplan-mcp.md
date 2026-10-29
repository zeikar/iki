---
"@ikijs/mcp": minor
---

BREAKING (0.x): `auto_rig_from_layers` takes `rigPlan` in place of `style`, and refuses a passed `style` (even `{}`) as `INVALID: style was removed: pass rigPlan — …` with the old-knob-to-new-path map, rather than dropping it. The result gains `rigPlan` (`requested`, `effective`, `clamped`, `overriddenBy`) and the text prints a `RIGPLAN:` line after the path. New tool `describe_rig_plan` lists the plan's fields with their defaults, ranges, recommended spans, steps and poses.

`rigPlan.turn` takes `eyeForeshorten` and `noseLead` (turn only); `describe_rig_plan` lists eight fields, the two new ones `provisional`, and the `RIGPLAN:` line reports them like the rest.
