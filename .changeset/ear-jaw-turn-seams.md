---
"@ikijs/editor": patch
---

**Every model rigged from this release on differs in the face plate's ear and jaw mesh and keyforms, and models rigged earlier are untouched until they are rigged again.** There is no `.iki` format change.

Two seams at the ±30° turn are fixed in the auto-rig:

- The near ear widens from the head's edge instead of sliding out from under it. Its root rides the head, the 0.87 lag applies at the ear's widest reach, and the far ear is unchanged. The ear island's tucked copy of the cheek's outline no longer shows as a doubled cheek outline and a pale notch.
- The chin's shade band thins to nothing where the full turn would carry its end past the neck's outline, so at ±30° the far side no longer drags an unlined neck-toned wedge past the neck. A dark cast shadow drawn beyond that reach stays on the neck.
