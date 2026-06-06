---
"@iki/format": minor
"@iki/engine": minor
---

Rotation deformer + pivot + parent hierarchy (#4a): @iki/format adds matrix-only IkiDeformer types (deformers field on model, deformer binding on parts) with validated acyclic hierarchy; @iki/engine composes deformer world matrices into the per-part transform chain about a pivot. Additive and optional — existing color/texture-quad models stay valid. Warp mesh, keyform, and per-vertex UV deformation deferred to #4b.
