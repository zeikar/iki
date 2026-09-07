---
"@ikijs/engine": patch
---

`IdleMotion`'s blink was a 120 ms symmetric triangle — the lid closed and
opened at one speed with a corner at the bottom. It now closes over 60 ms
(smoothstep), holds shut 20 ms and opens over 100 ms (ease-out), 180 ms in
all, which is how a blink reads: fast down, slower up, soft at both ends.
No API change; `drivenParameterIds` and the resting pose are unchanged.
