---
"@ikijs/format": patch
"@ikijs/engine": patch
"@ikijs/editor": patch
"@ikijs/mcp": patch
---

Ship `LICENSE` inside each package. Every package declared `"license": "MIT"`, but npm only picks up a package-ROOT licence file and does not follow a symlink, so the repo-root `LICENSE` never reached any tarball — the published artifacts named a licence they did not carry. The pre-publish check now gates on it alongside the README.
