---
"@ikijs/engine": patch
---

Report an un-awaited `load()` instead of silently reporting no parameters.

`load()` adopts the model only after decoding its textures, so calling
`getParameters()` on an un-awaited `load()` returned an empty list. A host
reasonably concludes the model declares no parameters and drives nothing —
no error, no motion, nothing to debug. That case now logs once via
`console.error` naming the fix.

An un-awaited _reload_ is deliberately not reported: those parameters are stale
rather than absent, and warning there would fire on legitimate concurrent reads.
