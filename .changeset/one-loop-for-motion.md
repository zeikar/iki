---
"@ikijs/engine": minor
---

`IkiMotion` runs the three motion drivers as one. Every host so far rebuilt
the same loop by hand: construct `IdleMotion`, `PhysicsMotion` and
`HairChainMotion` from the model, call them in that order each frame with
one timestamp, and keep a hand-written list of the parameters they touch
to restore on stop — a list the editor preview let drift when idle began
swaying `ParamAngleZ`. `new IkiMotion(model, read, sink)` now builds all
three, `update(nowMs)` runs them idle → physics → chains (physics has to
lag the pose idle just wrote), and `drivenParameterIds` publishes every id
they write so a host can put the pose back; each driver publishes its own
`drivenParameterIds` too, so the knowledge of what gets written stays with
the code that writes it. Scheduling stays with the
host — nothing here touches a timer or the DOM — and the three drivers stay
exported for a host that wants only some of them.
