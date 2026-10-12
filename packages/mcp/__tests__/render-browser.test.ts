import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutoRigInputError } from "../src/limits";
import {
  NO_BROWSER_MESSAGE,
  findBrowser,
  launchBrowser,
} from "../src/render-browser";

const only =
  (...files: string[]) =>
  (file: string) =>
    files.includes(file);

describe("findBrowser", () => {
  it("returns CHROME_PATH as-is when it is executable", () => {
    expect(
      findBrowser({
        env: { CHROME_PATH: "/opt/chrome" },
        platform: "linux",
        isExecutable: only("/opt/chrome"),
      }),
    ).toBe("/opt/chrome");
  });

  it("refuses a CHROME_PATH that is not an executable file", () => {
    const run = () =>
      findBrowser({
        env: { CHROME_PATH: "/opt/Chrome.app" },
        platform: "darwin",
        isExecutable: only(
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ),
      });
    expect(run).toThrow(AutoRigInputError);
    expect(run).toThrow(/CHROME_PATH.*\/opt\/Chrome\.app/);
  });

  it("picks the first executable candidate per platform", () => {
    const chromium = "/Applications/Chromium.app/Contents/MacOS/Chromium";
    const edge =
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
    expect(
      findBrowser({
        env: {},
        platform: "darwin",
        isExecutable: only(chromium, edge),
      }),
    ).toBe(chromium);
    expect(
      findBrowser({
        env: {},
        platform: "linux",
        isExecutable: only("/usr/bin/chromium", "/snap/bin/chromium"),
      }),
    ).toBe("/usr/bin/chromium");
    const chrome = path.win32.join(
      "C:\\Users\\a\\AppData\\Local",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    );
    const edgeWin = path.win32.join(
      "C:\\Program Files",
      "Microsoft",
      "Edge",
      "Application",
      "msedge.exe",
    );
    expect(
      findBrowser({
        env: {
          PROGRAMFILES: "C:\\Program Files",
          LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local",
        },
        platform: "win32",
        isExecutable: only(chrome, edgeWin),
      }),
    ).toBe(chrome);
  });

  it("returns undefined when nothing is installed", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(
        findBrowser({ env: {}, platform, isExecutable: () => false }),
      ).toBeUndefined();
    }
  });

  it("words the refusal around Chrome and CHROME_PATH", () => {
    expect(NO_BROWSER_MESSAGE).toMatch(/Chrome/);
    expect(NO_BROWSER_MESSAGE).toMatch(/CHROME_PATH/);
  });
});

describe("launchBrowser failures", () => {
  // A private TMPDIR keeps the leftover check from seeing other tests' profiles.
  let scratch: string;
  let savedTmp: string | undefined;
  beforeEach(() => {
    savedTmp = process.env.TMPDIR;
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "iki-launch-test-"));
    process.env.TMPDIR = scratch;
  });
  afterEach(() => {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const profiles = () =>
    fs.readdirSync(scratch).filter((name) => name.startsWith("iki-render-"));

  // A POSIX shell stub standing in for the browser.
  const stub = (script: string, mode = 0o755) => {
    const file = path.join(scratch, "chrome");
    fs.writeFileSync(file, script);
    fs.chmodSync(file, mode);
    return file;
  };

  it("rejects a non-executable file with the spawn code and leaves no profile", async () => {
    const file = stub("#!/bin/sh\n", 0o644);
    await expect(launchBrowser(file, 5000)).rejects.toThrow(/EACCES/);
    expect(profiles()).toEqual([]);
  });

  it("rejects a missing path with ENOENT and leaves no profile", async () => {
    await expect(
      launchBrowser(path.join(scratch, "no-such-browser"), 5000),
    ).rejects.toThrow(/ENOENT/);
    expect(profiles()).toEqual([]);
  });

  it("names the code and path when spawn throws, and leaves no profile", async () => {
    // A NUL byte makes spawn throw synchronously on every platform.
    const bad = "/bin/no\0such";
    const error = await launchBrowser(bad, 5000).catch((e) => e);
    expect(error.message).toContain("ERR_INVALID_ARG_VALUE");
    expect(error.message).toContain(bad);
    expect(profiles()).toEqual([]);
  });

  it("reports the stderr tail when the browser exits early", async () => {
    const file = stub("#!/bin/sh\necho boom >&2\nexit 1\n");
    await expect(launchBrowser(file, 5000)).rejects.toThrow(
      `${file} exited before DevTools was ready: boom`,
    );
    expect(profiles()).toEqual([]);
  });

  it("times out a browser that never reports DevTools", async () => {
    const file = stub("#!/bin/sh\nexec sleep 30\n");
    await expect(launchBrowser(file, 300)).rejects.toThrow(
      "browser startup timed out after 300 ms: no output",
    );
    expect(profiles()).toEqual([]);
  });
});
