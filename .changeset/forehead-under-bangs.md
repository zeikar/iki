---
"@ikijs/editor": patch
"@ikijs/mcp": patch
---

The forehead stays under the bangs on a head turn. The front hair's outer edge holds the head's outline while the face plate slides under it, so bangs that only just cover the forehead's sides let it out past them on the far side (up to 11 px at ±30 on the twin-tailed character). Above the eyes, a row where the front hair's outer edge lies at or outside the face's outline now holds the far side of the plate back, so that its outline lands no further out than that edge (within a pixel, as rendered), easing in to nothing toward the eyes' outer corner. The hold spreads to the rows within about three mesh cells of such a row, so the outline next to it turns a little less than the plate too, also where it shows. A layer set none of whose rows needs it — the hair covers the outline by more than the plate out-turns it, or the outline already shows past the hair at rest — rigs byte for byte as before; the turn fit is unchanged either way, and with a hold the report's side-lock numbers read the held plate. It needs the face's and the front hair's `rowRuns`.
