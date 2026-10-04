---
"@ikijs/mcp": minor
---

`compose_layers_from_parts` places the face and its features by new defaults, taken from the hero character's own tuning (bob), so a new character's first compose starts from a placement that reads naturally. The hair and torso defaults do not change. A layout that leaves one of these keys out now lands that part at its new default; to keep a character composed earlier where it was, set the old value in its layout.

- `face.cy` 437 (was 475). The face is drawn without a neck, so its box is the skull and sits above the eye row.
- `eye_*` / `lash_*`: `cx` 636 / 464 (was 657 / 443), `w` 98 (was 128).
- `iris_*`: `cx` 631 / 469 (was 653 / 447), `cy` 480 (was 475), `w` 50 (was 72).
- `brow_*`: `w` 105 (was 135).
- `nose`: `w` 20 (was 40). With no `cy`, its tip now lands 0.66 of the way from the eye row to the mouth's (was 0.86).
- `mouth` / `mouth_open`: `cy` 594 / 596 (was 619 / 621), `w` 76 (was 68).
- `blush_*`: `cx` 641 / 459 (was 662 / 438).
