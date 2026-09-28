---
"@ikijs/mcp": minor
---

The geometry report's lash drift check no longer flags a correctly composed
eye, and now catches a drift it used to miss. It compared the lash's ink
centre with the sclera's, within 3% of the eye width — but a lash stops short
of the tear duct, so an eye drawn the right way sits 3-5% off centre and
tripped it with a "Retune to match" nothing could act on. It now counts the
lash's opaque pixels that land off the sclera: in sync there are none, since
the sclera was recoloured from those very pixels, and on a real eye a 2 px
shift, either way, moved more than 2% of them off — including a lash drifting
in toward its bare tear duct, which stays inside the sclera's frame and which
the centre check let through. The top-edge check stays, and still catches a
lash scaled down inside its sclera with its aspect kept. The warning names
only the fault that fired (`lash_L: N of its M opaque px lie off eye_L's
sclera`, or its top-edge offset) instead of always quoting the centre offset.

A lash narrowed inside its sclera at the same height still lies on it and inks
its top row, so no check over the layers can see it — `compose_layers_from_parts`
now refuses the layout instead: `eye_L`/`lash_L` and `eye_R`/`lash_R` must land
on the same frame once placed, and a pair that does not is rejected as
`layout.lash_L places the lash at 120x86 (597,432), but layout.eye_L places its
sclera at 140x86 (587,432) — …`. It compares where the two land, not the values
set, so an `h` equal to the one the aspect gives still composes. This rejects a
layout an earlier 0.x composed with a drift warning — including an `h` set on
the sclera alone that changes its height, which the docs already said to set on
both.

Every placement is now checked before any layer is written, so a refused
compose — this frame mismatch, or a part placed entirely off the canvas —
leaves `outDir` as the last compose left it instead of half overwritten.
