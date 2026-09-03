---
"@ikijs/mcp": patch
---

The MCP server reported a hardcoded `version: "0.0.0"` in its `serverInfo`, which every MCP client shows in its server listing — so a published `@ikijs/mcp@0.1.0` would have introduced itself as 0.0.0, and drifted further with each release. The version is now baked from `package.json` at build time, and since the release script builds after the version bump, the published artifact always reports its own version.
