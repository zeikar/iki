---
"@ikijs/editor": patch
---

Keep the bangs' sway inside the face-warp grid. `hair_front`'s vertices are
swayed and parallax-shifted before they bind to the grid, and past its edge
they clamp to the edge column, flattening the tips into a line on a wide
fringe or a hard turn. The swing is now capped so one hair spring at its peak
stays inside; layouts with normal headroom are unchanged. The head-turn bakes
also take their cylinder radius from the grid's reach about the axis rather
than its outer columns, so the no-fold guarantee no longer assumes a grid
symmetric about the face.
