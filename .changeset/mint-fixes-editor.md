---
"@ikijs/editor": minor
---

`packAtlas(sources, padding?, maxSide?)` takes an optional `maxSide`: when the first shelf layout is taller than it (and not wider), the pack retries wider in 64 px steps and then at `maxSide` itself, and returns the first layout that fits, so a tall full body whose crops fit the area packs instead of being refused. Without `maxSide`, and for every set that packed before, the layout is identical.

The arm draws cap, forearm, upper arm: the upper arm draws over the forearm, so a bent elbow's inside overlap shows the elbow row's edge rather than the forearm's cut rotated up the sleeve.

The closed line's sag — how far its centre dips below its two ends — is capped at 0.10 of the opening's width, so a deeply drawn opening closes into a gentle smile instead of a V.

This is a pre-1.0 change to the rig:

- Re-rigging a full body with this release draws the forearm behind the upper arm. Busts have no arms and are unchanged.
- Re-rigging a lip set whose closed curve sagged past the cap closes it shallower, and its mouth anchor (the closed line's centre) moves with it, so the `mouthWarp` grid and the face's AngleX keys shift too: by up to about 5 px on a deep mouth (one that sagged 0.18 of its width), and by under 1 px on a mouth just past the cap (0.11: its closed centre 0.8 px shallower).
- An existing `.iki` keeps its baked keyforms and renders as it did (no engine change). Every legacy `mouth` / `mouth_open` rig is byte-identical.
