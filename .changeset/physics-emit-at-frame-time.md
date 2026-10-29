---
"@ikijs/engine": patch
---

`PhysicsMotion` emits the spring state carried forward to the frame's time (`x + v·remainder`) instead of the state at the last whole 1/60 s sub-step. With a varying number of sub-steps per frame (0/1/2 at 60 fps with timestamp noise, 0/1 at 120 Hz) a lag output saw-toothed by about ΔL·scale although its inputs moved smoothly, which showed as hair jitter. The integration, the seed frame and the finiteness guard are unchanged.
