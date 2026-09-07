---
"@ikijs/editor": patch
---

Auto-rigged bangs (`hair_front`) lead the head turn from their tips, not their
crown: the depth lead is now a root-pinned warp instead of a rigid translate,
so the crown no longer runs ahead of the back hair on a turn and the far-side
strands slide far less across the cheek. Rigs are regenerated, not migrated.
