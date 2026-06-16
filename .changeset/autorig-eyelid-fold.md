---
"@iki/editor-core": minor
---

Auto-rig: replace the scaleY-collapse blink with a Live2D-style eyelid FOLD. The eye-white (`eye_L`/`eye_R`) now carries two `EyeOpen` `IkiWarp` keyforms (via a new `bakeEyelidFoldWarp`) that collapse it toward a crease as the eye shuts, and `iris_/pupil_/highlight_` parts now clip to the white instead of blinking. As the white folds closed its clip region shuts, so the round iris is **cut away** (not vertically squashed) — the eyeball no longer deforms. An OPTIONAL `lash_L`/`lash_R` role (the upper lashes, drawn above the iris) folds down to the same crease to cover the closed seam cleanly. No `IKI_FORMAT_VERSION` bump (`IkiWarp` and clip are already v1).
