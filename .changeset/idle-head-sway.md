---
"@iki/engine": minor
---

`IdleMotion` now drives a gentle head sway on `ParamAngleX` / `ParamAngleY`
(sums of slow sines, ±3.5° / ±1.6°) alongside blink, breath, and gaze — so an
idle character keeps drifting instead of freezing solid, and hair physics
reading the head angle stays alive between interactions. Models without those
parameters ignore the writes.
