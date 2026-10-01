---
"@ikijs/mcp": minor
---

`compose_layers_from_parts` composes a cheek blush pair, `blush_L` and `blush_R`, from one optional `blush.png` drawn as the screen-left blush (it is mirrored for `blush_L`; pass `mirrorParts: ["blush.png"]` if it was drawn facing the other way). Both are new `layout` keys, so the pair can be retuned per character. It draws over the face and under the nose, and a parts set without `blush.png` raises no warning.

`compose_layers_from_parts` also drops a light mark drawn detached above the eye white, such as a double-eyelid crease, from the sclera, which is the iris's clip, so the iris no longer shows through it as a dashed line at half blink. Dark strokes there still count as lash ink, as before.
