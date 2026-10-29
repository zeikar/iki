---
"@ikijs/editor": minor
---

BREAKING (0.x): `GenerateOptions.style` and `RigStyle` are removed, with no alias. `GenerateOptions.rigPlan` (`RigPlan`, validated against the new `RIG_PLAN_FIELDS` catalog, a bad field throws `RigPlanError` with a path-qualified message) replaces them, carrying the six knobs over unchanged as `turn.amount`, `turn.featureLead`, `hair.follow`, `hair.outlineFollow`, `hair.sway` and `eyes.blink`. Passing `style` throws `RigPlanError` with the old-knob-to-new-path map. New `onRigPlanResolved` reports `requested`, `effective`, `clamped` and `overriddenBy` for every model that validates. A model rigged from an empty plan is byte-identical to before.

New turn-only fields in the same plan: `turn.eyeForeshorten` (the eyes' foreshortening per turn, [0, 2]) and `turn.noseLead` (the nose's lead over the plate, [0, 3]; the nod keeps the profile's nose). Their recommended spans are provisional planner choices. `turn.amount × turn.eyeForeshorten` must stay ≤ 4 (the fit's foreshortening bound), checked on the plan before any target is read. A given `turnTargets.farEyeRatio` / `noseShift` owns its field (the plan's value has no say), and the `onRigPlanResolved` echo reports `effective`, `clamped` and `overriddenBy` for both, finite in every in-range case.
