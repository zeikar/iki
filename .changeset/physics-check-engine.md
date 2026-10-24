---
"@ikijs/engine": minor
---

`checkPhysics(model)`: a report-only check that each physics rig moves the parts and stays bounded, with the engine's own drivers. It runs the real `PhysicsMotion`, `HairChainMotion` and `IdleMotion` on a synthetic 60 Hz clock, one fixed sub-step a frame, and reports a `PhysicsTarget` per `model.physics` rig and per chain segment: ok, frozen or unstable, what reads its output, its step and idle amplitude, and the largest vertex move in model px. The step holds a fresh rig's input at its far end, the end farther from its default, for 5 s; a chain steps every parameter that turns its anchor (probed at both ends and every warp keyform stop) alone, in its own run. The idle runs every rig and chain together behind the procedural idle, on a seeded rng, for 30 s. The pixels come from landing every part as the renderer lands it, at every value the step emitted, against the parts landed at rest.

A target is unstable when a spring's one-sub-step map has a spectral radius over 1 (exact, in closed form) or sits on its undamped boundary `dt²k/m = 4`, where the radius is exactly 1 but the state grows; when a driver's finiteness guard fires; or when the raw output stays past one bound of its range for 60 consecutive frames, in any run. A chain's update is nonlinear, so it gets no radius verdict: a chain that grows yet stays finite and inside its range trips none of these, and is deferred to a later slice (the auto-rig generates no chains); it shows only in the numbers. A target is frozen when nothing reads its output, its input has no range, nothing turns its chain's anchor, or the step moves the parts under 1 model px. Amplitudes are numbers only: however little the idle moves an output, that never flags, though a guard or a pin in the idle does.

`PhysicsMotion` and `HairChainMotion` gain `resets`, per output: how many times the finiteness guard reset its state or replaced a non-finite product — guard activations, not repaired frames. It is a diagnostic; the emitted values are unchanged.

Nothing is refused and rendering is unchanged. The engine still depends only on `@ikijs/format`, and `IKI_FORMAT_VERSION` is unchanged.
