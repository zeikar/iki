---
"@ikijs/mcp": patch
---

An arm hangs on a long-necked body's shoulders, not its neck. The composer's default shoulder pivot sat 0.12 of the body box's height under its top, which on a long neck (as the plugin's body prompt draws it) is the neck. When that row is the neck — above the shoulders the body's paint has (the first plateau of rows reached by a step, not a flare's tail) and under 0.6 of their width — the pivot now lands the arm's cap radius under the shoulders' first row, the cap's top on the shoulder line; every other body, a silhouette flaring all the way down (an A-line dress, a cloak) included, places its arms as before. The measure's shoulder-cap check no longer tells an arm hung on the neck to move toward the body by the neck's edge (which put it on the neck): it names the neck and the px to move the arm's `cy` down.
