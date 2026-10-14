---
"@ikijs/mcp": minor
---

`auto_rig_from_layers` takes `patches`, the editor's rig patch ops, inline: each is replayed on the fresh rig, echoed as a `PATCH` line between the path and the fold report, and returned in the result's `patches`. An op the rig refuses comes back as `INVALID: patches[i]…` and nothing is written.

`describe_iki` takes `modelPath` (exactly one of it and `model`) and shows the patch writer's view: each part's rest `box` in model px and `bustBox` in bust-render px, its `warps` and their stops, each `warp2d`'s `stopsX` and `stopsY`, and the result's `faceWidth` and `bustScale`.

`render_poses` takes `poses`: caller-named poses (`name`, `values`, optional `crop` in model px, clamped to the canvas) rendered instead of the standard set, and swept by the fold report after the engine's own poses.

No engine or format change.
