---
name: iki-visual-test
description: Drive a Playwright browser session against the Iki playground dev server to visually verify renderer changes (parts, deformers, textures, tint, and future warp meshes). Uses the dev injection API at `window.__iki` to set parameters by id, swap in a minimal test model, settle a frame, and screenshot. Use whenever a render-layer change needs visual confirmation that headless vitest can't give.
---

# Iki Visual Test (Playwright + dev API)

Drive a Playwright session against `pnpm playground` to capture screenshots of renderer changes. The `window.__iki` dev API (attached by `examples/playground/src/main.ts` only when `import.meta.env.DEV`) is the canonical injection surface — set parameters by id, optionally swap in a deterministic minimal `.iki` model, settle one render cycle, screenshot.

The engine renders in a continuous `requestAnimationFrame` loop (`IkiPlayer.start()`), so a parameter change is picked up on the next frame automatically — `__iki.nextFrame()` just waits for that frame to paint before the screenshot. There is no manual "force redraw".

## When to use

- A change touches `packages/engine/src/**` with a visual effect: the per-part transform chain / matrix math (`player.ts`, `deform.ts`, `affine.ts`), the shader / `u_useTexture` / tint path, deformer-world composition, texture upload/sampling.
- A change touches `packages/format/src/**` in a way that changes what renders (e.g. a new schema field the engine consumes — deformers, textures, future mesh/warp).
- A change touches `examples/playground/**` (the demo model or its wiring).
- The user shares a screenshot pointing at an awkward visual ("head pivots wrong", "eyes float", "texture bleeds", "tint looks off").

## When NOT to use

- Pure matrix/eval/validator logic with a numeric expectation — that is what `pnpm test` (vitest `deform.test.ts` / `affine.test.ts` / `validate.test.ts`) is for. Assert the math there; only use this skill for the pixels.
- A non-render change (format-only validation, types, docs).

## Prerequisites

- `pnpm playground` running on `http://localhost:5173` (vite). Probe + reuse; start it backgrounded if down.
- The build is dev (`import.meta.env.DEV` is true under `vite` / `pnpm playground`), so `window.__iki` is attached. In a production `vite build` it is intentionally stripped.
- The Playwright MCP server is available (`mcp__plugin_playwright_playwright__*` tools).

## Procedure

### Step 1 — Ensure the dev server is up

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173 || echo "down"
```

If down, start it backgrounded with the Bash tool (`run_in_background: true`) running `pnpm playground` from the repo root. Vite prints `Local: http://localhost:5173/` when ready; wait for that line before navigating. If 5173 is taken, vite falls back to 5174+ — point Playwright at the responding port.

### Step 2 — Navigate + wait for the dev API

`mcp__plugin_playwright_playwright__browser_navigate { url: "http://localhost:5173" }`, then poll for the hook:

```js
async () => {
  for (let i = 0; i < 30; i++) {
    if (window.__iki?.player) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    ready: !!window.__iki,
    params: window.__iki?.getParams().map((p) => p.id),
  };
};
```

Always read parameter ids/ranges from `__iki.getParams()` — do NOT hardcode them. The current sample model declares `ParamAngleX` (Head Angle, −30..30), `ParamBreath`, `ParamMouthOpenY`, `ParamMouthForm`, `ParamEyeLOpen`, `ParamEyeROpen`, `ParamEyeBallX`, `ParamEyeBallY`, but a swapped-in model (Step 3b) can declare anything.

### Step 3a — Drive the demo model by parameter

Set parameters by id, then settle a frame before the screenshot:

```js
async () => {
  const api = window.__iki;
  api.reset(); // back to declared defaults
  api.setParam("ParamAngleX", 30); // full head turn one way
  api.setParam("ParamMouthOpenY", 1);
  api.setParam("ParamEyeLOpen", 0); // blink left
  await api.nextFrame();
  return "ok";
};
```

`setParam` clamps to the parameter's range (exactly as the engine does) and mirrors the value into its slider so screenshots show the correct thumb position. `reset()` returns every parameter to its default.

### Step 3b — (Powerful) swap in a minimal deterministic model

To verify a render feature in ISOLATION (just a deformer hierarchy, just a tinted quad), build the smallest `.iki` model that exercises it and load it. `__iki.load` runs the real `parseIkiModel` first, so a malformed test model throws here (a free validity check):

```js
async () => {
  await window.__iki.load({
    version: /* IKI_FORMAT_VERSION — read it from getParams-era model or import */ 1,
    name: "deformer-iso",
    canvas: { width: 1000, height: 1000 },
    parameters: [
      { id: "ParamAngleX", name: "Angle", min: -30, max: 30, default: 0 },
    ],
    deformers: [
      {
        id: "neck",
        pivot: { x: 0, y: -300 },
        bindings: [
          { parameter: "ParamAngleX", channel: "rotate", from: 20, to: -20 },
        ],
      },
    ],
    parts: [
      {
        id: "face",
        deformer: "neck",
        order: 0,
        transform: { x: 0, y: 0 },
        width: 400,
        height: 400,
        color: [1, 0.8, 0.7, 1],
      },
    ],
  });
  window.__iki.setParam("ParamAngleX", 30);
  await window.__iki.nextFrame();
  return "ok";
};
```

(Check the exact required fields against `packages/format/src/types.ts` / `validate.ts` — the validator is the source of truth, and a wrong shape will throw in `load`.)

### Step 4 — Screenshot (save under `.playwright-mcp/`)

Always save under `.playwright-mcp/` — the Playwright MCP scratch dir — never the repo root. A single `rm -rf .playwright-mcp/` at the end then leaves the working tree clean with no `.gitignore` entry:

```
mcp__plugin_playwright_playwright__browser_take_screenshot {
  type: "png",
  filename: ".playwright-mcp/<feature>-<state>.png",
}
```

Read the screenshot back to inspect it, and capture before/after states (e.g. `angle-0.png`, `angle-plus30.png`, `angle-minus30.png`) so the change is visible as a comparison.

### Step 5 — Check console errors

A render bug often surfaces as a thrown `IkiFormatError` (bad model) or a WebGL error, not a wrong pixel. Confirm the console is clean:

```
mcp__plugin_playwright_playwright__browser_console_messages { level: "error" }
```

0 errors means `parseIkiModel` passed and WebGL is healthy. (A favicon 404 may inflate the navigate summary's error count but is not a JS error — the `level: "error"` console fetch is authoritative.)

### Step 6 — Cleanup (MANDATORY before finishing the turn)

```bash
rm -rf .playwright-mcp/
```

Then close the Playwright page (`mcp__plugin_playwright_playwright__browser_close`). If a screenshot is worth keeping (PR attachment), copy it OUTSIDE the repo (`/tmp/`, `~/Desktop/`) before deleting `.playwright-mcp/`. Do NOT add `.playwright-mcp/` to `.gitignore` as a workaround — the skill cleans up after itself.

Do NOT shut down the user's dev server. If the skill started one in Step 1, leave it running (the user keeps iterating); the backgrounded process stays alive.

## Dev API surface (reference)

`window.__iki` (dev only — attached in `examples/playground/src/main.ts`, typed in `examples/playground/src/vite-env.d.ts`):

| Path                   | Description                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `.player`              | The live `IkiPlayer` instance.                                                                            |
| `.getParams()`         | Parameter descriptors `{ id, name, min, max, default }[]`. Use for ids + ranges.                          |
| `.setParam(id, value)` | Set a parameter by id (clamped to its range); mirrors the value into its slider.                          |
| `.reset()`             | Reset every parameter to its declared default.                                                            |
| `.load(rawModel)`      | `parseIkiModel(rawModel)` then atomically swap the model + rebuild controls. Throws on a malformed model. |
| `.nextFrame()`         | Resolve after one render cycle has painted — await before screenshotting.                                 |

## Anti-patterns

- **Scraping slider DOM** (finding `input[type=range]` by order/label and dispatching `input` events) when `__iki.setParam(id, ...)` exists. The dev API is robust to slider order/label changes; DOM scraping is brittle.
- **Screenshotting without `await __iki.nextFrame()`** after a `setParam` / `load`. The change lands on the next RAF frame; screenshotting immediately can capture the prior frame.
- **Saving screenshots to the repo root** (`angle.png` at the top level — what an early ad-hoc run did). Always under `.playwright-mcp/` so one `rm -rf` wipes them.
- **Adding `.playwright-mcp/` to `.gitignore`** as a workaround for MCP scratch files. Step 6 cleanup is the contract.
- **Shutting down the user's dev server** on cleanup. Leave it running.
- **Using this skill to assert matrix/eval correctness.** Numeric expectations belong in vitest (`deform.test.ts`); this skill is for the pixels only.
- **Hardcoding parameter ids.** Read them from `__iki.getParams()` — a swapped-in test model (Step 3b) declares its own.
- **Trusting the navigate summary's error count.** Use `browser_console_messages { level: "error" }` — a favicon 404 inflates the summary but is not a JS/WebGL error.
