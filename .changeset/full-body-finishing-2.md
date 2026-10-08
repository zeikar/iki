---
"@ikijs/engine": minor
---

`IkiPlayer.setView(view?)` and the `IkiView` type: a host-owned view in model
units (centre `x`/`y` and `width`/`height`) that the engine fits and centres
instead of the model's box. Use it for a full body whose raised arms leave the
box, or for a face crop. Unset, rendering is unchanged; it throws on a
non-finite or non-positive view, and it survives `load()`.

The room is the host's to choose: a combined pose (arm, outward elbow, body and
head lean) sets how far the model reaches, and only the host knows its pose set.
Nothing in the format moves; `IKI_FORMAT_VERSION` is unchanged.
