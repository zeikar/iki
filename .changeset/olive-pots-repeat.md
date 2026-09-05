---
"@ikijs/editor": minor
"@ikijs/mcp": minor
---

Pin the cylinder axis in the head-turn warp bake.

Rotating a cylinder slides its whole visible surface sideways by
`RADIUS * sin(theta)` on top of foreshortening it — 170px on a 430px-wide face
at 30 degrees. That bulk slide is what pushed a generated head off its
shoulders, dragged the neck with it, and left the back hair trailing as a
separate mass; the foreshortening on its own is what reads as a turn.

The bake now subtracts the axis column's own displacement, so the centre of the
face holds still and only the differential remains. Offsets stay monotonic, so
no grid cell folds. Deliberate lateral head motion is unaffected — it lives on
`headDeformer`'s `translateX` binding, where it can be tuned on its own.

Generated models turn less far sideways than before. Shrinking `RADIUS` was the
other candidate and is a trap: below the grid's half-width the outer columns
saturate at `asin(±1)` and cross over their neighbours, inverting the mesh.
