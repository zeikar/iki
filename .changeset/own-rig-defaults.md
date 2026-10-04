---
"@ikijs/editor": minor
---

**Every model rigged from this release moves by new amounts: it turns, nods, rolls, blinks, gazes, opens its mouth, raises its brows, breathes and sways by the auto-rig's new defaults.** Models rigged earlier are untouched until they are rigged again, and the `.iki` format does not change.

The defaults are now our own values, picked by eye on our own characters in a blind comparison (`AUTO-RIG.md` has the values and how they were picked), replacing the previous defaults, which had been measured on third-party sample models. `profile.ts` derives what each region does from a short list of them (`PROFILE_VALUES`, `deriveProfile`); the rules — a turn is parallax, the nose leads most, the neck and the torso stay — are unchanged.

- The face plate keeps its width on the turn, the mouth stays level, and the eyes keep their height on the nod; the brows sit at the eyes' depth, and the near ear rides the head.
- The roll is 14° at AngleZ ±30 (was 10°), and the brows raise and lower further.
- The head unit `hh` is now exactly the eye row → the chin tip.
- `RigStyle`'s defaults: `hairFollow` 1 (was 1.1), `blink` 0.6 (was 0.58). The knobs and their accepted ranges do not change; `AUTO-RIG.md` lists the ranges that read well.
- `DEFAULT_TURN_TARGETS` is now `{ eyeShift: 0.23, farEyeRatio: 0.73, silhouetteRatio: 1 }` (was 0.22 / 0.78 / 1).
