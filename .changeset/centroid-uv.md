---
"@ikijs/engine": patch
---

A part no longer draws a faint 1 px line of its atlas neighbour's colour along
its top or left edge. The WebGL2 context is multisampled, and a pixel a
triangle only partly covers was shaded at its centre even when that lay
outside the triangle, so the texture coordinate ran past the part's atlas rect
into the gutter above it — which holds the edge of whichever part is packed
there (a generated character's back hair picked up its body's cream sweater).
The texture coordinate is now interpolated at the covered samples
(`centroid`), which keeps it inside the part's rect. Every model benefits,
including ones already rigged; nothing about the `.iki` format changes.
