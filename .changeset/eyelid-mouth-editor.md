---
"@ikijs/editor": minor
---

New optional roles `mouth_inner`, `lip_lower` and `lip_upper`: a mouth drawn as a lip set, back to front, that folds open on `MouthOpen` the way the eyelid folds. `mouth_inner` is the interior with the opening's lower outline, `lip_lower` is the lower lip's skin, and `lip_upper` is the upper lip with its line. There is no closed drawing: closed is the lips meeting on one line, a seam 0.3 of the interior's height below its top, which also sets the closed line's curve. On open the lower outline folds with the interior, and the upper lip and the lower lip move per column on shared 4 px knots. `MouthForm` and the 1.2x widen run on one frame shared by the three parts, and the mouth anchor (head frame and solve) is the seam at the opening's centre column. `ROW_RUN_ROLES` gains the three roles, so the measurer records their row runs.

`mouth` is no longer unconditionally required. A layer set needs `face`, `eye_L`, `eye_R`, and `mouth` or the complete lip set. A partial lip set, or a lip set mixed with `mouth` or `mouth_open`, is refused. This is a pre-1.0 change to the layer-set input: a layer set that names the lip roles needs this release, as an earlier `@ikijs/editor` refuses an unknown role. The `.iki` format is unchanged, and every layer set with `mouth` (with or without `mouth_open`) rigs byte-identically.
