/**
 * Browser discovery and a headless DevTools driver for `render_poses`: find a
 * system Chrome/Edge/Chromium, launch it, and evaluate scripts over the
 * DevTools protocol on Node's global `WebSocket`. No Playwright, no dependency.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutoRigInputError } from "./limits";

export const NO_BROWSER_MESSAGE =
  "render_poses needs a Chromium-based browser and found none. Install Google Chrome, Microsoft Edge or Chromium, or set CHROME_PATH to its executable.";

const DARWIN_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];
const LINUX_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
  "/snap/bin/chromium",
];
const WIN32_ROOTS = ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"];
const WIN32_SUFFIXES = [
  ["Google", "Chrome", "Application", "chrome.exe"],
  ["Microsoft", "Edge", "Application", "msedge.exe"],
];

const CLOSE_GRACE_MS = 2000;
const DEFAULT_TIMEOUT_MS = 30000;
const BROWSER_CLOSE_MS = 1000;

function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface FindBrowserOptions {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  isExecutable: (file: string) => boolean;
}

/** The browser to drive, or `undefined` when none is installed. */
export function findBrowser({
  env = process.env,
  platform = process.platform,
  isExecutable = isExecutableFile,
}: Partial<FindBrowserOptions> = {}): string | undefined {
  const override = env.CHROME_PATH;
  if (override) {
    // A bad override must not fall through to spawn, where it fails obscurely.
    if (!isExecutable(override)) {
      throw new AutoRigInputError(
        `CHROME_PATH is not an executable file: ${override}`,
      );
    }
    return override;
  }
  let candidates: string[];
  if (platform === "darwin") candidates = DARWIN_CANDIDATES;
  else if (platform === "win32") {
    candidates = [];
    for (const suffix of WIN32_SUFFIXES) {
      for (const root of WIN32_ROOTS) {
        const base = env[root];
        if (base) candidates.push(path.win32.join(base, ...suffix));
      }
    }
  } else candidates = LINUX_CANDIDATES;
  return candidates.find((file) => isExecutable(file));
}

export type Evaluate = (
  expression: string,
  timeoutMs: number,
) => Promise<unknown>;

export interface Browser {
  openPage(): Promise<Evaluate>;
  close(): Promise<void>;
}

interface RuntimeEvaluate {
  result: { value?: unknown };
  exceptionDetails?: {
    text: string;
    exception?: { description?: string; value?: unknown };
  };
}

/**
 * Race `promise` against a timer, clearing the timer either way. `detail`
 * adds context to the timeout message, read only when it fires.
 */
function within<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
  detail?: () => string,
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${what} timed out after ${ms} ms${detail ? `: ${detail()}` : ""}`,
          ),
        ),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface CdpClient {
  send<T = unknown>(
    method: string,
    timeoutMs: number,
    params?: object,
    sessionId?: string,
  ): Promise<T>;
}

function connectCdp(url: string, timeoutMs: number): Promise<CdpClient> {
  const socket = new WebSocket(url);
  let nextId = 0;
  let socketClosed = false;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const entry = pending.get(message.id);
    if (!entry) return; // a protocol event, not a reply
    pending.delete(message.id);
    if (message.error) {
      entry.reject(
        new Error(`${message.error.message} (${message.error.code})`),
      );
    } else entry.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    socketClosed = true;
    for (const entry of pending.values()) {
      entry.reject(new Error("DevTools connection closed"));
    }
    pending.clear();
  });
  const opened = new Promise<CdpClient>((resolve, reject) => {
    socket.addEventListener("error", () =>
      reject(new Error("DevTools connection failed")),
    );
    socket.addEventListener("open", () =>
      resolve({
        send<T>(
          method: string,
          callTimeoutMs: number,
          params?: object,
          sessionId?: string,
        ) {
          // send() on a closed socket is silent; fail now, not at the timeout.
          if (socketClosed) {
            return Promise.reject(new Error("DevTools connection closed"));
          }
          const id = ++nextId;
          const reply = new Promise<T>((res, rej) => {
            pending.set(id, {
              resolve: res as (v: unknown) => void,
              reject: rej,
            });
          });
          socket.send(JSON.stringify({ id, method, params, sessionId }));
          return within(reply, callTimeoutMs, method).finally(() =>
            pending.delete(id),
          );
        },
      }),
    );
  });
  // Closing the socket on failure lets a hung connect not outlive the launch.
  return within(opened, timeoutMs, "DevTools connection").catch((error) => {
    socket.close();
    throw error;
  });
}

function startError(executable: string, error: NodeJS.ErrnoException): Error {
  return new Error(
    `could not start ${executable}: ${error.code ?? error.message}`,
  );
}

/** The DevTools websocket URL Chrome prints on stderr once it is ready. */
function waitForDevTools(
  child: ChildProcess,
  closed: Promise<void>,
  getSpawnError: () => NodeJS.ErrnoException | undefined,
  executable: string,
  timeoutMs: number,
): Promise<string> {
  let tail = "";
  return within(
    new Promise<string>((resolve, reject) => {
      // Keeps draining after the match so Chrome never blocks on a full pipe.
      child.stderr!.on("data", (chunk) => {
        tail = (tail + chunk).slice(-2000);
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(tail);
        if (match) resolve(match[1]);
      });
      void closed.then(() => {
        const spawnError = getSpawnError();
        reject(
          spawnError
            ? startError(executable, spawnError)
            : new Error(
                `${executable} exited before DevTools was ready: ${tail.trim()}`,
              ),
        );
      });
    }),
    timeoutMs,
    "browser startup",
    () => tail.trim() || "no output",
  );
}

async function openPage(cdp: CdpClient, timeoutMs: number): Promise<Evaluate> {
  const { targetId } = await cdp.send<{ targetId: string }>(
    "Target.createTarget",
    timeoutMs,
    { url: "about:blank" },
  );
  const { sessionId } = await cdp.send<{ sessionId: string }>(
    "Target.attachToTarget",
    timeoutMs,
    { targetId, flatten: true },
  );
  return async (expression, evalTimeoutMs) => {
    const { result, exceptionDetails } = await cdp.send<RuntimeEvaluate>(
      "Runtime.evaluate",
      evalTimeoutMs,
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (exceptionDetails) {
      // A thrown non-Error has no description; its value beats "Uncaught".
      const thrown = exceptionDetails.exception;
      throw new Error(
        thrown?.description ??
          (thrown && "value" in thrown
            ? String(thrown.value)
            : exceptionDetails.text),
      );
    }
    return result.value;
  };
}

/** Cleanup must not replace the result of a render that already finished. */
function removeProfile(profile: string): void {
  try {
    fs.rmSync(profile, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  } catch (error) {
    console.error(`could not remove browser profile ${profile}:`, error);
  }
}

/**
 * Start `executable` headless and connect to it. `timeoutMs` bounds startup
 * and every DevTools call `openPage` makes; each evaluate has its own.
 */
export async function launchBrowser(
  executable: string,
  timeoutMs: number,
): Promise<Browser> {
  if (typeof globalThis.WebSocket === "undefined") {
    throw new AutoRigInputError(
      "render_poses needs Node 22 or newer (the global WebSocket is missing).",
    );
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "iki-render-"));
  let child: ChildProcess;
  try {
    child = spawn(
      executable,
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        // Output pixel sizes must equal the plan's, whatever the display.
        "--force-device-scale-factor=1",
        // WebGL without a GPU; recent Chrome no longer falls back by itself.
        "--enable-unsafe-swiftshader",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (error) {
    // Some failures (ENOEXEC, EINVAL on Windows) throw instead of emitting.
    fs.rmSync(profile, { recursive: true, force: true });
    throw startError(executable, error as NodeJS.ErrnoException);
  }
  // Both in the spawn tick: a failed spawn is an `error` event, not a throw,
  // and `close` fires even when no `exit` does.
  let spawnError: NodeJS.ErrnoException | undefined;
  child.on("error", (error) => {
    spawnError = error;
  });
  let exited = false;
  const closed = new Promise<void>((resolve) => {
    child.on("close", () => {
      exited = true;
      resolve();
    });
  });
  const settle = (ms: number) =>
    within(closed, ms, "browser close").catch(() => {});

  // The server can die mid-render (SIGTERM, host gone); 'exit' handlers run
  // synchronously, so the browser and its profile do not outlive it.
  const onProcessExit = () => {
    child.kill("SIGKILL");
    removeProfile(profile);
  };
  process.once("exit", onProcessExit);

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () =>
    (shutdownPromise ??= (async () => {
      if (!exited) {
        child.kill();
        await settle(CLOSE_GRACE_MS);
        if (!exited) {
          child.kill("SIGKILL");
          await settle(CLOSE_GRACE_MS);
        }
      }
      process.removeListener("exit", onProcessExit);
      removeProfile(profile);
    })());

  let cdp: CdpClient;
  try {
    const endpoint = await waitForDevTools(
      child,
      closed,
      () => spawnError,
      executable,
      timeoutMs,
    );
    cdp = await connectCdp(endpoint, timeoutMs);
  } catch (error) {
    await shutdown();
    throw error;
  }

  return {
    openPage: () => openPage(cdp, timeoutMs),
    async close() {
      if (!exited) {
        // Best effort: a polite close lets Chrome flush; kill follows anyway.
        await cdp.send("Browser.close", BROWSER_CLOSE_MS).catch(() => {});
      }
      await shutdown();
    },
  };
}

/** Launch, open a page, run `fn`, and always close the browser. */
export async function withBrowser<T>(
  executable: string,
  fn: (evaluate: Evaluate) => Promise<T>,
): Promise<T> {
  const browser = await launchBrowser(executable, DEFAULT_TIMEOUT_MS);
  try {
    return await fn(await browser.openPage());
  } finally {
    await browser.close();
  }
}
