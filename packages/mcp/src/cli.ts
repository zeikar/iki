#!/usr/bin/env node
import { createIkiMcpServer } from "./server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

async function main() {
  const server = createIkiMcpServer();
  await server.connect(new StdioServerTransport());
}

// Turn signals into a normal exit so 'exit' handlers (a render's browser
// cleanup) run; the default action would skip them.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => process.exit(0));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
