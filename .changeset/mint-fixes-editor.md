---
"@ikijs/editor": minor
---

`packAtlas(sources, padding?, maxSide?)` takes an optional `maxSide`: when the first shelf layout is taller than it (and not wider), the pack retries at every width from the widest padded crop up to `maxSide` and returns the first layout that fits, so a tall full body that fits at some width up to `maxSide`, in the packer's shelf order, packs instead of being refused. An invalid `maxSide` (non-finite or not positive) throws. Without `maxSide`, and for every set that packed before, the layout is identical.

The arm draws cap, forearm, upper arm: the upper arm draws over the forearm, so a bent elbow's inside overlap shows the elbow row's edge rather than the forearm's cut rotated up the sleeve.

The closed line is a smooth parabola from end to end, its sag — how far its centre dips below its two ends — capped at 0.10 of the opening's width, the drawn line's own arc included, so a deeply drawn opening closes into a gentle smile instead of a V. A kink drawn in the line (a V at its centre) keeps only its offset from the line averaged over a few columns: a line whose bottom dips 10 rows in a V across a 60-column opening closes 7.5 px deep, about 1.5 px past the cap.

This is a pre-1.0 change to the rig:

- Re-rigging a full body with this release draws the forearm behind the upper arm. Busts have no arms and are unchanged.
- Re-rigging a lip set changes its closed line's shape as well as its depth: it closes onto the parabola, so a drawn kink no longer survives shut. One whose closed curve sagged past the cap closes shallower — a line drawn deeper than the cap closes flatter than drawn — and its mouth anchor (the closed line's centre) moves with it, so the `mouthWarp` grid and the face's AngleX keys shift too: by up to about 5 px on a deep mouth (one that sagged 0.18 of its width), and by about 1 px on a mouth just past the cap (0.11). The parabola's ends sit on the line's bottom averaged over a few columns, so a line whose bottom steps at the opening's end columns (a wall a hand split left standing) moves its centre too, even under the cap: about 4 px shallower on a line stepping 3 and 6 px down at its two end columns.
- An existing `.iki` keeps its baked keyforms and renders as it did (no engine change). Every legacy `mouth` / `mouth_open` rig is byte-identical.
