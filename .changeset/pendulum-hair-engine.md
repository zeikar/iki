---
"@ikijs/engine": minor
---

`PhysicsMotion` follows or lags each of a rig's inputs. The spring chases the sum of every input's signed-normalized value × `weight`, and the output carries `scale·(x − L)`, `L` being the lag inputs' share of that sum: a follow input (also when `mode` is absent, so every existing rig plays as before) holds the output displaced while its value holds, and a lag input swings the output while its value moves, then lets it settle back to rest. A rig seeded with a lag input already displaced emits rest, without a kick. Inputs are not smoothed, so a one-frame step on a lag input snaps the output by `−scale·weight·Δn` before the spring catches up. A non-finite timestamp re-emits every rig's last output without reading its inputs.
