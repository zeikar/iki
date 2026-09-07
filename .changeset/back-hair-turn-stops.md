---
"@ikijs/editor": patch
---

The back hair (`hair_back`) now keys its turn bend at the same five stops as the
face (`HEAD_TURN_STOPS`, 15° apart) instead of ±30 only, and its far side now
moves linearly with the angle. On the near side the bend is the same sin-based
cylinder the face uses, sampled analytically at every stop: with three stops the
engine's linear blend diverged from it by 12.5 model units at the near outer
column at half turn, where the face's five stops keep it under 4 model units —
at 15° the two silhouettes disagreed. The far side instead takes the chord of
its own ±30 keyform, because a cylinder's far column wraps back past ~12° and,
net of the bulge, the far edge moved 52 model units through the first 15° and
only 24 through the second: it swung out and then stalled, where it should swing
out at one speed (now 38 and 38). The ±30 keyforms, the rest keyform and the
far-side bulge ramp are unchanged at every angle. Rigs are regenerated, not
migrated.
