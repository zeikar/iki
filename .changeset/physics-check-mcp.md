---
"@ikijs/mcp": minor
---

`auto_rig_from_layers` and `render_poses` report the model's physics: both results carry a new `physics` field, the engine's `checkPhysics` over the model's own rigs (a `render_poses` call's `poses` do not enter it), and both texts end with it after the fold report — one `PHYSICS` line per spring and per chain segment, reading `ok`, `frozen` or `unstable`: the rig and `input -> output`, the step's setting (the input held at its far end for 5 s) with the output's peak, when, its final value and the largest part move in model px with what it drives, then the 30 s idle's peak, when and move, and ` — <why>` when flagged (drives nothing, no input range, under 1 model px over the step, a pin outside the range for a second, a finiteness-guard reset, a spring's step map over radius 1 or on its undamped boundary) — or `PHYSICS: no rigs`. The auto-rig's two hair-sway springs, which a `hair_front` layer brings, read `ok`. A chain that grows yet stays finite and inside its range is not flagged yet; it shows in the numbers only. Report-only: nothing refuses a rig or fails a render.

The check ships in the package's Node build, which inlines the workspace engine as it already does for the fold check. No format change.
