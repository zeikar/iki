---
"@ikijs/format": minor
"@ikijs/engine": minor
---

A model can declare expressions and motion clips, and the engine plays them.

- `@ikijs/format`: adds the optional `expressions` (parameter values blended
  `add`, `multiply` or `overwrite`, with fades) and `motions` (linear keyframe
  clips, grouped by name) fields on `IkiModel`, each entry with a required
  description, and `IDLE_MOTION_GROUP` (`"Idle"`). A clip's `fadeIn` and
  `fadeOut` may not exceed its duration, and an `Idle` clip may not animate
  blink or breath. The change is additive, but earlier versions silently
  dropped these keys, so a model carrying malformed ones now fails to load (v1
  is unstable before 1.0).
- `@ikijs/engine`: `IkiMotion` gains `playExpression(id)`, `stopExpression()`
  and `playMotion(group, index)`. `playMotion` replaces a running one-shot, and
  the new clip fades in from the old one's last pose. Each frame runs idle,
  then clips, then expressions, then physics and chains; the host writes its
  own signals (lip-sync) after `update()` and wins. A declared `Idle` group
  replaces the procedural head sway and gaze, while blink and breath stay.
  Models without these fields behave as before.
