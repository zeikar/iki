---
"@ikijs/mcp": patch
---

`cut_layers_from_illustration` reads the upper lash's lower edge over the iris correctly under a lash drawn with flicks, a soft top edge or a lighter streak:

- The lash's thickness beside the iris is read from the eye's inside (the first ink above the iris's centre row), where a flick above the lash used to be taken for the lash and make it read a few px thick. Over an iris as dark as the lash at its top, the lash's lower rows then went to the iris layer, and the `iris` check's "disc found" took the lash band in: an ellipse stretched up into the lash scored higher than one on the disc, and the hint asked for the ellipse to move up.
- The lash's run of ink passes over a flick that stands clear of the lash, and carries on through a streak of up to six rows drawn along the lash in a paint lighter than its ink (though nearer the ink than the white), both over the iris and where its thickness is read.
- A lower lid is carried across the iris only when its line shows on every one of the four columns beside the ellipse, each within a row of the last. The iris's own outline beside an ellipse set a pixel or two inside it used to be taken for a lid, and a band of the iris went to the lower lash.

A cut can change where the picture's lash has those features: the iris, upper lash and lower lash layers split on the corrected edge.
