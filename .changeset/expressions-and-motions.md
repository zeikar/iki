---
"@ikijs/format": minor
"@ikijs/engine": minor
---

A model can declare expressions and motion clips, and the engine plays them.

- `@ikijs/format`: adds the optional `expressions` (parameter values blended
  `add`, `multiply` or `overwrite`, with fades) and `motions` (keyframe clips,
  grouped by name, whose curves are `smooth` monotone cubics by default or
  `linear`) fields on `IkiModel`, each entry with a required description,
  `IDLE_MOTION_GROUP` (`"Idle"`), and `DEFAULT_FADE_SECONDS`, the length of a
  fade left out (on a clip, at most half its duration; `0` is instant). A
  clip's `fadeIn` and `fadeOut` may not exceed its duration, and an `Idle`
  clip may not animate blink or breath. The change is additive, but earlier
  versions silently dropped these keys, so a model carrying malformed ones now
  fails to load (v1 is unstable before 1.0).
- `@ikijs/engine`: `IkiMotion` gains `playExpression(id)`, `stopExpression()`
  and `playMotion(group, index)`. Replacing an expression or a running
  one-shot fades in from the current pose. Fades ease in and out along a
  smoothstep. Each frame runs idle, then clips, then expressions, then
  physics and chains; the host writes its own signals (lip-sync) after
  `update()` and wins. A declared `Idle` group replaces the procedural head
  sway and gaze, while blink and breath stay. Models without these fields
  behave as before.
