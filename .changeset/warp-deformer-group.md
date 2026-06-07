---
"@iki/format": minor
"@iki/engine": minor
---

Warp deformer / group warp (#4c): @iki/format adds an `IkiDeformer` discriminated union (`IkiMatrixDeformer` | `IkiWarpDeformer`) with `IkiWarpGrid`/`IkiGridKeyform`/`IkiGridWarp`; a part referencing a `kind:"warp"` deformer must carry a `mesh` (path-qualified validation). @iki/engine resolves each warp deformer's deformed control grid per frame (parent matrix affine + single-parameter grid keyforms), binds child mesh vertices to the rest grid, and renders them by bilinear-sampling the deformed grid into the dynamic VBO, bypassing the affine deformer chain. Additive — `kind` omitted means `"matrix"`, so existing #4a/#4b/texture-quad models stay valid (no version bump, pre-release). Bezier/bicubic patches, multi-parameter grid blends, nested warp deformers, and matrix-under-warp are deferred.
