---
"@ikijs/mcp": patch
---

The lip set carries no green fringe. The key leaves green in an antialiased edge pixel it has no ramp to read (a halo off the line from the ink to the fill, or a share it takes for the stroke's own shading), and the resize spreads it, so `lip_upper` and `mouth_inner` showed a green rim at every opening. `compose_layers_from_parts` and `cut_layers_from_illustration` now despill the five layers the split writes: a pixel's green is clamped to the larger of its red and blue, alpha untouched, so no read of the fold changes. The measure's green check reads what is drawn: a pixel's excess green at its own alpha over 16 levels, where it read only opaque pixels over 40, which passed the fringe; its remedy is recomposing (free) before regenerating.
