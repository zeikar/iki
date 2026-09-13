---
"@ikijs/editor": minor
---

The head-turn cylinder's radius is an explicit input to the face-warp bake and
to the depth-parallax unit, instead of being re-derived from how far the warp
grid happens to reach. The bend is bounded with it, so columns the radius
cannot carry follow the silhouette rigidly rather than folding. Internal to
auto-rig generation: the generated rig passes the radius it derived before, so
that refactor on its own leaves rigged models unchanged.

Auto-rigged front hair now holds the head's silhouette through that turn. The
bangs carry a per-vertex warp that inverts the face grid's own column map, so
the side strands keep their rest outline — as far out as the turned grid
reaches — while the plate beneath them foreshortens, instead of the whole head
narrowing with it. Rigs generated from now on carry the extra warp on
hair_front; already-rigged models change only when they are rigged again.
