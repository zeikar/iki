---
"@ikijs/mcp": patch
---

The measure's shoulder-cap check no longer tells an arm hung on a long neck to move onto the neck. When the cap falls short and the body is much narrower on the pivot's row than below it in its upper band (a pivot row under 0.6 of the widest row there), the warning says what it measured and gives both readings: if that row is the neck, move the arm's `cy` down by the px the shoulder line, read off `preview.png`, lies under that row; if it is the shoulders over a wider garment, move its `cx` toward the body by the px. An arm that passes the cap check is never warned. The composer's default pivot is unchanged: 0.12 of the body box's height under its top for every body.
