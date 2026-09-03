import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  AutoRigInputError,
  resolveInputPath,
  resolveOutputPath,
} from "../src/limits";

/**
 * Path resolution is the tool's only filesystem boundary, so its rejection
 * branches are the most expensive place in the package for a regression to
 * hide. Everything here uses paths that already exist in the repo — the tests
 * create nothing, and vitest runs with the repo root as cwd.
 */

describe("resolveInputPath", () => {
  it("resolves an existing file", () => {
    expect(resolveInputPath("package.json")).toMatch(/package\.json$/);
  });

  it.each(["", "   "])("rejects an empty path (%j)", (bad) => {
    expect(() => resolveInputPath(bad)).toThrow(AutoRigInputError);
    expect(() => resolveInputPath(bad)).toThrow(/layer path is empty/);
  });

  it.each(["https://example.com/a.png", "file:///tmp/a.png"])(
    "rejects a URL (%s)",
    (url) => {
      expect(() => resolveInputPath(url)).toThrow(
        /must be a file path, not a URL/,
      );
    },
  );

  it("rejects a missing file", () => {
    expect(() => resolveInputPath("no-such-layer.png")).toThrow(
      /layer file not found/,
    );
  });

  it("rejects a directory", () => {
    expect(() => resolveInputPath("packages")).toThrow(
      /is a directory, not a file/,
    );
  });

  // Reads are deliberately NOT confined to cwd — see the note on
  // resolveInputPath. Locking this in so the asymmetry is a decision, not drift.
  it("accepts a readable file outside the working directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iki-limits-"));
    const outside = path.join(dir, "layer.png");
    fs.writeFileSync(outside, "");
    try {
      expect(resolveInputPath(outside)).toBe(outside);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveOutputPath", () => {
  it("resolves a .iki path under the working directory", () => {
    expect(resolveOutputPath("out.iki")).toMatch(/\/out\.iki$/);
  });

  it.each(["", "   "])("rejects an empty path (%j)", (bad) => {
    expect(() => resolveOutputPath(bad)).toThrow(/output path is empty/);
  });

  it("rejects a non-.iki extension", () => {
    expect(() => resolveOutputPath("out.json")).toThrow(/must end in \.iki/);
  });

  it("rejects a missing parent directory", () => {
    expect(() => resolveOutputPath("no/such/dir/out.iki")).toThrow(
      /output directory does not exist/,
    );
  });

  it("rejects a parent that is a file, not a directory", () => {
    expect(() => resolveOutputPath("package.json/out.iki")).toThrow(
      /output parent is not a directory/,
    );
  });

  it.each(["/tmp/escape.iki", "../escape.iki"])(
    "rejects a path escaping the working directory (%s)",
    (bad) => {
      expect(() => resolveOutputPath(bad)).toThrow(
        /escapes the working directory/,
      );
    },
  );
});
