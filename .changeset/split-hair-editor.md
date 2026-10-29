---
"@ikijs/editor": minor
---

The auto-rig gives the back hair its own spring: a rigged set with `hair_front` and `hair_back` declares `ParamHairBackSway` and a third `hairBack` physics rig (slower than the front's, with a lag-mode ambient so it swings a beat behind). The two front springs now drive `hair_front` only.
