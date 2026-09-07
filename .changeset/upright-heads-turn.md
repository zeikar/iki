---
"@ikijs/editor": patch
---

Auto-rigged heads no longer roll with the turn. The ±6° "lean into the turn"
on `AngleX`, inherited from the hand-authored sample, rotated the whole head
about the neck pivot — which sits about a head below the crown — so on every
turn the top of the head swung far further than the chin and read as lunging
ahead of the face. The turn is now a pure yaw (translate + face warp); roll is
`AngleZ`'s alone.
