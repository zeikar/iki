---
"@ikijs/mcp": minor
---

Rig a character you already drew as one finished picture. Two new tools take a single front-facing illustration (PNG, JPEG or WebP) to the role layers `auto_rig_from_layers` rigs, with no generated parts and no ML.

`view_illustration_grid` writes a zoomed view of the picture on the 1100 px wide layer canvas with a labelled grid, so an agent reads exact coordinates off it, and draws a set of landmarks over it to check them.

`cut_layers_from_illustration` cuts the picture in place from those landmarks: the eyes, brows, nose and mouth, the front and back hair, the face and the body as role layers, and parts the rig has no role for (twin tails, a ponytail) as `custom/<id>.png`. Hair is told from skin by colour samples the agent places on each, and what each layer hides when the rig moves it (the forehead under the bangs, the hair behind the face, the neck behind the chin, the skin under each feature) is filled from the paint around it. Given the composer's lip-set inputs (`mouthKeyed` + `mouthInterior`), it writes a mouth that opens, placed on the drawn mouth's corners, in place of the drawn closed one. It reports numbers an agent acts on, each naming the landmark to move: whether the layers stack back into the picture, whether each seed and sample sits on its paint, whether each eye box and iris ellipse fits the drawing, how much of each fill was made up far from any paint, and whether the front hair is wider than the face; then the `measure_layers` checks a cut can act on, and `CUT pass` or `CUT FAIL`. Bad landmarks are refused as `INVALID: landmarks.<path> …`, and a refusal writes nothing.
