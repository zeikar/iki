import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseIkiGenerator } from "@ikijs/format";
import { PLUGIN_ENV } from "../src/generator";

const read = (file: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../plugin/${file}`, import.meta.url), "utf8"),
  );

describe("the plugin's name for itself", () => {
  // Three files are bumped by hand; a model records the one in `.mcp.json`.
  it("is the manifests' name and version in the environment the tool server is launched with", () => {
    const claude = read(".claude-plugin/plugin.json");
    const codex = read(".codex-plugin/plugin.json");
    expect(codex.version).toBe(claude.version);
    expect(codex.name).toBe(claude.name);
    const label = read(".mcp.json").mcpServers.iki.env[PLUGIN_ENV];
    expect(label).toBe(`${claude.name}@${claude.version}`);
    expect(parseIkiGenerator({ tool: "-", plugin: label }).plugin).toBe(label);
  });
});
