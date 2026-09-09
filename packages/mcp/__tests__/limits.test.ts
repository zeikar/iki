import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  AutoRigInputError,
  resolveInputDir,
  resolveInputPath,
  resolveOutputDir,
  resolveOutputPath,
  writeFileAtomic,
} from "../src/limits";

/**
 * Path resolution is the tool's only filesystem boundary, so its rejection
 * branches are the most expensive place in the package for a regression to
 * hide. Most cases use paths that already exist in the repo; the tests that
 * need a path genuinely outside cwd (or a symlink that escapes it) create
 * real temp directories and clean them up. vitest runs with the repo root as
 * cwd.
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

describe("resolveInputDir", () => {
  it("resolves an existing directory", () => {
    expect(resolveInputDir("packages")).toMatch(/packages$/);
  });

  it.each(["", "   "])("rejects an empty path (%j)", (bad) => {
    expect(() => resolveInputDir(bad)).toThrow(AutoRigInputError);
    expect(() => resolveInputDir(bad)).toThrow(/layers dir is empty/);
  });

  it.each(["https://example.com/layers", "file:///tmp/layers"])(
    "rejects a URL (%s)",
    (url) => {
      expect(() => resolveInputDir(url)).toThrow(
        /must be a directory path, not a URL/,
      );
    },
  );

  it("rejects a missing directory", () => {
    expect(() => resolveInputDir("no-such-layers-dir")).toThrow(
      /layers dir not found/,
    );
  });

  it("rejects a file", () => {
    expect(() => resolveInputDir("package.json")).toThrow(/not a directory/);
  });

  // Reads are deliberately NOT confined to cwd — see the note on
  // resolveInputPath, which resolveInputDir shares. Locking this in so the
  // asymmetry is a decision, not drift.
  it("accepts a readable directory outside the working directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iki-limits-dir-"));
    try {
      expect(resolveInputDir(dir)).toBe(dir);
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

describe("resolveOutputDir", () => {
  // node_modules is gitignored, so a dir created under it satisfies output
  // confinement to the working directory; cleaned up after (matching
  // tools.test.ts's tmpDir helper).
  const createdDirs: string[] = [];
  function tmpDir(): string {
    const d = fs.mkdtempSync(
      path.join(process.cwd(), "node_modules", ".iki-limits-outdir-"),
    );
    createdDirs.push(d);
    return d;
  }
  // A directory genuinely OUTSIDE the working tree, for confinement tests.
  function outsideDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "iki-limits-out-"));
    createdDirs.push(d);
    return d;
  }
  afterAll(() => {
    for (const d of createdDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it("resolves an existing directory under cwd", () => {
    const dir = tmpDir();
    expect(resolveOutputDir(dir)).toBe(fs.realpathSync(dir));
  });

  it("rejects a missing directory", () => {
    expect(() => resolveOutputDir("no-such-output-dir")).toThrow(
      /output dir not found/,
    );
  });

  it("rejects an absolute directory outside the working directory", () => {
    const outside = outsideDir();
    expect(() => resolveOutputDir(outside)).toThrow(
      /escapes the working directory/,
    );
  });

  it("rejects a symlink under cwd pointing outside the working directory", () => {
    const dir = tmpDir();
    const outside = outsideDir();
    const link = path.join(dir, "link");
    fs.symlinkSync(outside, link);
    expect(() => resolveOutputDir(link)).toThrow(
      /escapes the working directory/,
    );
  });
});

describe("writeFileAtomic", () => {
  it("writes data to the target path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iki-limits-write-"));
    const target = path.join(dir, "out.iki");
    try {
      writeFileAtomic(target, "hello");
      expect(fs.readFileSync(target, "utf8")).toBe("hello");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaces an existing symlink at the target instead of following it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iki-limits-write-"));
    const linkTarget = path.join(dir, "link-target.iki");
    const link = path.join(dir, "link.iki");
    fs.symlinkSync(linkTarget, link);
    try {
      writeFileAtomic(link, "replaced");
      // The symlink's target was NOT written; the link itself was replaced
      // by a real file (matching tools.test.ts's autoRigFromLayers assertion).
      expect(fs.existsSync(linkTarget)).toBe(false);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(link, "utf8")).toBe("replaced");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
