---
"@ikijs/format": minor
"@ikijs/engine": minor
"@ikijs/editor": minor
---

A matrix deformer may hang from a warp deformer and rides it rigidly.

- `@ikijs/format`: a matrix deformer may name a warp deformer as its
  `parent`. Its rest `pivot` must lie inside the warp's rest grid, or
  `parseIkiModel` throws a path-qualified `IkiFormatError`. A warp under a
  warp is still rejected, and a physics-chain segment output that drives a
  warp ancestor's parameter is rejected as feedback. `IKI_FORMAT_VERSION` is
  unchanged (v1 is unstable before 1.0), but **a model that uses this is
  rejected by an earlier `@ikijs/format`** ("matrix deformers cannot be
  children of a warp deformer"), so a host on an older engine or format
  cannot load it.
- `@ikijs/engine`: matrix and warp deformers resolve in one topological
  pass. A matrix child follows its warp parent rigidly: its pivot is mapped
  through the deformed grid and it takes the warp's local rotation, with no
  scale or shear. Existing models resolve as before. A `HairChainMotion`
  anchored under a warp now follows the warp's rotation.
- `@ikijs/editor`: `validateDeformerReparent` and `SetDeformerParent` accept
  a matrix target under a warp parent when its pivot lies inside the warp's
  rest grid; a pivot outside it, or a warp child, is refused before the model
  or the undo stack changes.
