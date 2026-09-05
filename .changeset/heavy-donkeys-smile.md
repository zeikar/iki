---
"@ikijs/editor": minor
"@ikijs/mcp": minor
---

Add a `body` role to the auto-rigger for a character's torso.

Every existing role hangs from either `faceWarp` or `headDeformer`, and
`headDeformer` rotates the whole head about the neck pivot — so there was no way
to rig shoulders that stay put while the head turns, and a generated character
read as a floating head. `body` is the one role attached to no deformer at all:
it is emitted as a static quad with `part.deformer` omitted, drawn over
`hair_back` and under `face`.

`RoleSpec.deformer` widens to `"faceWarp" | "headDeformer" | "none"`.
`auto_rig_from_layers` accepts `body.png` in its layer set as a result.

A layer set that includes a `body` also shortens the head's sideways travel on a
turn (50px to 18px). The wider travel reads fine when the whole figure moves
together, but against still shoulders it visibly detaches the head. A layer set
without a `body` produces exactly the model it did before.
