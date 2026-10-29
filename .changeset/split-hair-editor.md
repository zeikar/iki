---
"@ikijs/editor": minor
---

The auto-rig gives the back hair its own spring: a rigged set with `hair_front` and `hair_back` declares `ParamHairBackSway` and a third `hairBack` physics rig (slower than the front's, with a lag-mode ambient so it swings a beat behind). The two front springs now drive `hair_front` only.

The hair swings wider and settles faster: `AMPLITUDE.sway` 0.08 → 0.24 (a hair tip travels 0.24 hh at full sway, the idle drift about 0.015 → 0.044 hh) and all three hair springs are damped to ζ 0.40 (front k 77, c 4.4 → 7, f₀ 1.40 Hz; back k 32, c 2.8 → 4.5, f₀ 0.90 Hz). Chosen from renders: at ζ 0.25 the wider hair rang twice for about 0.8 s after the Shake clip, at ζ 0.40 it settles in about 0.2 s.

The back spring's output scale is 7 (not 11) with its `AmbientSway` lag weight at 1.73 (not 1.1), so the idle drift is unchanged (scale × weight 12.1) while a full −30 to +30 head sweep in 200 ms peaks at 18.9 instead of clipping the ±20 range at 23.6.
