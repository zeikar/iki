---
"@ikijs/mcp": minor
---

`auto_rig_from_layers` and `render_poses` report the model's folds: both results carry a new `folds` field, the engine's `checkFolds` over its own pose set, and both texts end with it — a `FOLD` line per warp grid or mesh part that flips or collapses at some pose (its cell or triangle, the ratio, the pose as its parameter settings, where it rests in model space and in model px from the top-left) or `FOLDS: none over N poses`, then a `FOLDS expected:` line naming the closures the auto-rig draws on purpose: `eye_L` and `lash_lower_L` shut by `ParamEyeLOpen`, `eye_R` and `lash_lower_R` by `ParamEyeROpen`, and `mouth_inner`, `mouth_tongue`, `mouth_teeth`, `lip_lower` and `lip_upper` with `ParamMouthOpenY` at 0. Report-only: a fold never refuses a rig or fails a render. `render_poses` also returns `modelCanvas`, the model's own canvas, whose top-left the fold lines' px are measured from.

`render_poses` adds a `stress` shot after `combined`: every head angle at −30 with the mouth open, both eyes at 0.5, the brows at opposite extremes and each body angle the model declares at −10. `combined` is unchanged.

The package's Node build now inlines the workspace engine for the fold check, as its page script already did; `@ikijs/format` stays external. No format or engine change.
