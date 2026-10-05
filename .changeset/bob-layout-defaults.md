---
"@ikijs/mcp": minor
---

`compose_layers_from_parts` places the face and its features by new defaults, so a new character's first compose starts from a placement that reads naturally. The face, eyes, irises, lashes, brows, nose and mouth take the hero character's own tuning (bob). Bob wears no blush, so the blush keeps its old rule relative to the eyes (just outside each eye's centre, below its row), picked on bob's face. The hair and torso defaults do not change.

The features' defaults are now proportions of the face: a layout that moves or resizes the face (`face.cx` / `cy` / `w`) carries the blush, nose, mouth, eyes, irises, lashes and brows with it, scaled by the face's width. A feature's own override still names canvas px, and a layout that leaves the face alone places them exactly at the values below.

A layout that leaves one of these keys out now lands that part at its new default. To keep a character composed earlier where it was, set the old value in its layout. A layout that moved or resized the face and set its features' keys keeps them; one that moved the face and left a feature's key out now moves that feature with the face.

- `face.cy` 437 (was 475). The face is drawn without a neck, so its box is the skull and sits above the eye row.
- `eye_*` / `lash_*`: `cx` 636 / 464 (was 657 / 443), `w` 98 (was 128).
- `iris_*`: `cx` 631 / 469 (was 653 / 447), `cy` 480 (was 475), `w` 50 (was 72).
- `brow_*`: `w` 105 (was 135).
- `nose`: `w` 20 (was 40). With no `cy`, its tip now lands 0.66 of the way from the eye row to the mouth's (was 0.86).
- `mouth` / `mouth_open`: `cy` 594 / 596 (was 619 / 621), `w` 76 (was 68).
- `blush_*`: `cx` 641 / 459 (was 662 / 438).
