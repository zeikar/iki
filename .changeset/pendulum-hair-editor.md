---
"@ikijs/editor": minor
---

The auto-rig's hair swings like a pendulum. With `hair_front`, `hairSway` lags `ParamAngleX` and follows the idle's new `ParamAmbientSway` at weight 0.25 (`inputs`, scale 14), and `hairTilt` lags `ParamAngleZ` (scale 9), both at mass 1, stiffness 77, damping 4.4 (f₀ 1.4 Hz, ζ 0.25). The hair trails a turn or tilt, overshoots and settles back to rest while the head holds, where it used to stay a quarter swung toward a held turn (40 % toward a held roll); the roll's static hang stays the warps'. An instant step of the head to its end swings the sway at most 14 (the tilt, 9). The rig declares `ParamAmbientSway` ("Ambient Sway", −1..1, default 0) beside `ParamHairSwayX`/`Z`, so in idle the hair drifts on its own. `style.sway` scales the tip travel per sway unit, so the turn's swing and the idle drift alike. A rigged model therefore needs an `@ikijs/format` that reads `inputs` and `mode` to load, and an `@ikijs/engine` that plays `lag` to swing as designed.
