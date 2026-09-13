---
"@ikijs/editor": minor
---

The head-turn cylinder's radius is an explicit input to the face-warp bake and
to the depth-parallax unit, instead of being re-derived from how far the warp
grid happens to reach. The bend is bounded with it, so columns the radius
cannot carry follow the silhouette rigidly rather than folding. Internal to
auto-rig generation: the generated rig passes the radius it derived before, so
rigged models are unchanged.
