---
"@iki/engine": minor
---

New `IdleMotion` export: a host-agnostic idle-motion driver that animates the standard "life" parameters — auto-blink on `ParamEyeLOpen`/`ParamEyeROpen`, a breath cycle on `ParamBreath`, and a subtle gaze drift on `ParamEyeBallX`/`ParamEyeBallY`. It is pure logic: the host supplies time via `update(nowMs)` and owns the animation loop; randomness is injectable for deterministic tests. Scheduling runs on an internal clamped-delta clock, so a backgrounded tab can't snap a blink shut or teleport the gaze. Models lacking the standard ids are unaffected (unknown ids are ignored). No `@iki/format` change.
