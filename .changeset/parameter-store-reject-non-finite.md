---
"@ikijs/engine": minor
---

`ParameterStore.set` (and therefore `IkiPlayer.setParameter`) now ignores non-finite values instead of storing them. `clamp` could not filter `NaN` — `Math.max(min, Math.min(max, NaN))` is `NaN` — so a single bad host frame (lip-sync, gaze, blink) poisoned the parameter and every binding, transform, and `normalized()` read that followed, with no recovery short of `reset()`. A dropped write now holds the last good pose. Note the behavior change for `±Infinity`: it previously clamped to the range and is now dropped alongside `NaN`, so the boundary applies one rule to all non-finite input.
