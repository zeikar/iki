---
"@ikijs/engine": minor
---

`checkFolds(model, options?)` and `foldPoses(model)`: a report-only check for folds in a rig, with the engine's own evaluation. `foldPoses` lists the poses to check: rest, every movable parameter alone at its min and at its max, and every corner of the declared head and body angles alone, then crossed with each eye on its own, the mouth, the arms and the elbows shut and open (2112 corner poses at most, besides rest and the single extremes). `checkFolds` sweeps every warp deformer's grid cells and every mesh part's triangles over them and reports, per target, the least ratio of a triangle's signed area at a pose to the same at rest, with that pose and where the triangle sits: at or under 0 a flip, under 0.1 a collapse. An optional `expected` predicate keeps by-design closures (a mouth shut) apart from defects.

A part's triangles land as the renderer lands them, against its authored mesh through the static matrix chain: a static scale or reflection cancels out, a bound one counts, and a vertex that lies past its warp grid's edge (where the grid pins it) shows already at rest.

Nothing is refused and rendering is unchanged. The engine still depends only on `@ikijs/format`, and `IKI_FORMAT_VERSION` is unchanged.
