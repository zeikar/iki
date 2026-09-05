---
"@ikijs/editor": minor
"@ikijs/mcp": minor
---

Add a `mouth_open` role so a rigged mouth can actually open.

With only a closed-mouth drawing, mouth-open was `scaleY` 0..3 on art that is
typically a ~15px-tall line. Stretching it four times over produces a blurred
band, not an open mouth — fine for a portrait, useless for lip-sync.

A layer set that also supplies `mouth_open` now cross-fades the two drawings on
`ParamMouthOpenY` through the `opacity` channel, which the format and engine
already supported, and the closed mouth is no longer stretched. `MouthForm`
still drives `scaleX` on whichever drawing is showing.

Layer sets without a `mouth_open` layer keep the stretch and produce exactly the
model they did before.
