---
"@ikijs/editor": minor
---

BREAKING (0.x): `GenerateOptions.style` and `RigStyle` are removed, with no alias. `GenerateOptions.rigPlan` (`RigPlan`, validated against the new `RIG_PLAN_FIELDS` catalog, a bad field throws `RigPlanError` with a path-qualified message) replaces them, carrying the six knobs over unchanged as `turn.amount`, `turn.featureLead`, `hair.follow`, `hair.outlineFollow`, `hair.sway` and `eyes.blink`. Passing `style` throws `RigPlanError` with the old-knob-to-new-path map. New `onRigPlanResolved` reports `requested`, `effective`, `clamped` and `overriddenBy` for every model that validates. A model rigged from an empty plan is byte-identical to before.
