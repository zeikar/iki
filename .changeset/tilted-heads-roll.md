---
"@ikijs/editor": minor
---

Auto-rigged models can now tilt their head. `generateIkiFromLayerSet` declares
`ParamAngleZ` (−30..30) and gives `headDeformer` a `rotate` binding of one
degree per degree about the neck pivot. Positive AngleZ rolls the head
clockwise on screen — the top of the head toward the viewer's right — which is
Live2D's convention (its sample motions give AngleZ the sign of AngleX 214 times
out of 222) and the same sense as the rig's existing lean into a turn, so a
host's head-tracking roll maps onto AngleZ 1:1. The two rotations sum, as two
rolls about one pivot should.
