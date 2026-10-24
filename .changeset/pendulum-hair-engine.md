---
"@ikijs/engine": minor
---

`PhysicsMotion` follows or lags each of a rig's inputs. The spring chases the sum of every input's signed-normalized value × `weight`, and the output carries `scale·(x − L)`, `L` being the lag inputs' share of that sum: a follow input (also when `mode` is absent, so every existing rig plays as before) holds the output displaced while its value holds, and a lag input swings the output while its value moves, then lets it settle back to rest. A rig seeded with a lag input already displaced emits rest, without a kick. Inputs are not smoothed, so a one-frame step on a lag input snaps the output by `−scale·weight·Δn` before the spring catches up. A non-finite timestamp re-emits every rig's last output without reading its inputs.

`checkPhysics` steps each input of a spring alone and reports the run that moves the parts most. A spring's `input` lists every input in rig order, `step.values` names the reported run's setting, instability is read over every run and the idle (a `why` naming a multi-input run's setting, as a chain's does), and a spring none of whose inputs has a range reads `frozen` naming them. A lag input's step peaks at once at `−scale·weight` (less one sub-step) and its `final` reads rest. A one-input spring reports the same numbers and wording as before.
