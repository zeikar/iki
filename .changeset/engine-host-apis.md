---
"@ikijs/engine": minor
---

Three things a host needs to drive the engine without guessing at its state.

New `IkiMotion.activeMotion()`: the one-shot `playMotion` started, as `{ group, index }`, or `null` before any and from the `update()` that plays it out. It runs on the clips' own clock, which advances at most `MAX_DT_MS` per update, so a long frame gap does not end it early; a rejected `playMotion` leaves it as it was. The engine only reports it: which clip may interrupt which stays the host's call.

Behavior change: `setGazeTarget(x, y)` now moves the eyes on a model that declares an `Idle` motion group, where it used to move nothing and a host wrote `EyeballX/Y` itself after `update()`. The eyes spring to the target as the idle eyes do (same stiffness, clamped to ±1, a non-finite pair ignored); the head stays the `Idle` clips', with no follow. While a target is set it wins over any `EyeballX/Y` the `Idle` clips animate, and a one-shot or an expression still composes over it; with no target set the clips' eyes play as before. `clearGazeTarget()` springs the eyes back to what the clips write, else to their resting values, writes them there exactly once, and stops writing them, so nothing of the target is left in the store. Under an `Idle` group `drivenParameterIds` now lists `EyeballX/Y`. A host that wrote the eyes itself after `update()` should drop that and call `setGazeTarget` instead; written after `update()` they still win, as any host write does. A model without an `Idle` group behaves exactly as before.

New `IkiPlayer.cancelLoad()`: supersedes any in-flight `load()` as a newer one would (it resolves `{ superseded: true, failedTextures: [] }` and adopts nothing), while the installed model stays and keeps rendering. For a host whose next request failed before it reached `load()`, which would otherwise let the older load land after it. With no load in flight it does nothing.
