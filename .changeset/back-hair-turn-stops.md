---
"@ikijs/editor": patch
---

The back hair (`hair_back`) now keys its turn bend at the same five stops as the
face (`HEAD_TURN_STOPS`, 15° apart) instead of ±30 only. Its bend is the same
sin-based cylinder the face uses, so with three stops the engine's linear blend
diverged from the analytic bend by ~14 px at the outer column at half turn,
where the face's five stops keep it under 4 px — at 15° the two silhouettes
disagreed. The far-side bulge, which grows linearly with the angle rather than
with the bend, is now scaled by the angle so the extra stops sample its ramp
instead of stepping it to full at 15°; its contribution is unchanged at every
angle. Rigs are regenerated, not migrated.
