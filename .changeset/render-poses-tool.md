---
"@ikijs/mcp": minor
---

New `render_poses` tool: renders a rigged `.iki` into the character loop's pose PNGs with the real engine, through the installed Chrome, Edge or Chromium run headless (no Playwright). The package now bundles the workspace engine into a page script (`dist/render-page.global.js`) for it. No engine or format change. The new tool needs Node 22 or newer (the other tools still run on older Node).
