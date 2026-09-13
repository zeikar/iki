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

The head turn is now solved from a measured 30° reference instead of tuned
constants. `generateIkiFromLayerSet` takes `options.turnTargets` — how far the
eye pair slides, how much the far eye foreshortens, how much the silhouette
narrows, and the head's measured half-width — and fits the cylinder's radius
and every feature's depth to them on the same column map the rig renders with,
defaulting to `DEFAULT_TURN_TARGETS` (a 3/4 portrait's own cues). The slide is
bounded by the face plate — a feature past the contour is drawn over the side
hair, which bends with the plate and swallows it — and by the held silhouette.
A target the CALLER passed that the layer set cannot reach throws, naming the
field and the range it could have had; one that came from the defaults is
clamped to what the layer set can do, so a rig is always produced. Rigs
generated from now on turn to those cues; already-rigged models change only
when they are rigged again.
