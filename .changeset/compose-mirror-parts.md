---
"@ikijs/mcp": minor
---

`compose_layers_from_parts` takes a new optional `mirrorParts` — part files to
flip left-right as they are read, e.g. `["eyewhite.png"]`. It flips the
source, so every role cut from it flips together and an eye's sclera and lash
stay in one frame. A part drawn facing the other way is now a free fix rather
than a billed regeneration. An entry that is not a part file (a typo, or a role
such as `eye_L`) is rejected as `mirrorParts[i]: unknown part …`.

The composer reads `eyewhite.png` as the eye on the screen left (lash wing at
the image's left end, lash-free tear duct at its right) and `brow.png` as the
brow on the screen right (thick head at the image's left end). That was always
the case; it is now documented in image terms, since "left eye" reads as the
viewer's left or the character's.

The geometry report (`measure_layers`, and inline in the compose result) gains
a check: an eye whose lash, inside the frame it shares with the sclera, stops
more than 2% of the eye width further short of the outer corner than of the
nose side is reported as drawn facing the other way, naming
`mirrorParts: ["eyewhite.png"]` as the fix. It reads the ends rather than the
ink's centroid, so a long thin wing at the outer corner reads correctly. A
layer set that passed before can now warn — one real run's three eyewhite
variants all came back reversed, and composed as-is they trip it.
