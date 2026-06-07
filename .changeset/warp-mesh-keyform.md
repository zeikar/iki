---
"@iki/format": minor
"@iki/engine": minor
---

Warp mesh + per-vertex UV + single-parameter keyform interpolation (#4b): @iki/format adds optional `IkiMesh`/`IkiKeyform`/`IkiWarp` types and part `mesh`/`warps` fields (`warps` requires `mesh`) with path-qualified validation; @iki/engine renders mesh parts via `drawElements` with per-vertex `a_uv` and applies CPU single-parameter keyform delta interpolation into a dynamic VBO each frame. Additive — existing color/texture-quad and #4a deformer models stay valid and continue through the preserved implicit-quad draw behavior / UV formula (the shared shader gains a mesh branch; the quad branch's output is preserved). 2D parameter grid, multi-parameter warp, and SLERP/non-linear interpolation are deferred.
