---
"@ikijs/format": minor
"@ikijs/engine": minor
---

Rotation deformer + pivot + parent hierarchy (#4a): @ikijs/format adds matrix-only IkiDeformer types (deformers field on model, deformer binding on parts) with validated acyclic hierarchy; @ikijs/engine composes deformer world matrices into the per-part transform chain about a pivot. Additive and optional — existing color/texture-quad models stay valid. Warp mesh, keyform, and per-vertex UV deformation deferred to #4b.
