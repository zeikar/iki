---
"@iki/format": minor
"@iki/engine": minor
---

Add spring-mass-damper secondary motion. `@iki/format` gains an optional, additive `IkiPhysics` rig schema on `IkiModel.physics` — a 1D spring (`input`/`output` parameter refs + `mass`/`stiffness`/`damping`) validated with path-qualified `IkiFormatError` (declared input/output ids, `input !== output`, no duplicate output, no output-as-input feedback, `mass > 0`/`stiffness > 0`/`damping >= 0`). `@iki/engine` gains a new `PhysicsMotion` host-agnostic driver — the physics peer of `IdleMotion`: it reads an input parameter, signed-normalizes it around its default × `weight`, integrates a lagging spring with semi-implicit Euler on a fixed 1/60s sub-step accumulator (clamped dt + catch-up cap), and writes `outputDefault + position × scale` onto the output parameter so it lags and overshoots (hair/accessory sway). Spring constants are seconds-based. This is an additive `.iki` change with NO `IKI_FORMAT_VERSION` bump (pre-release v1); playground/example changes are not part of this changeset.
