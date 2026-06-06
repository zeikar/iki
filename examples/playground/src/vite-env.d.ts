/// <reference types="vite/client" />

import type { IkiPlayer } from "@iki/engine";
import type { IkiParameter } from "@iki/format";

declare global {
  interface Window {
    /**
     * Dev-only visual-test hook (attached only when `import.meta.env.DEV`).
     * Drives the playground deterministically for the iki-visual-test skill.
     * See .claude/skills/iki-visual-test.
     */
    __iki?: {
      player: IkiPlayer;
      /** Parameter descriptors (id, name, min, max, default). */
      getParams(): IkiParameter[];
      /** Set a parameter by id; mirrors the value into its slider. */
      setParam(id: string, value: number): void;
      /** Reset every parameter to its declared default. */
      reset(): void;
      /** Parse + atomically swap the model, then rebuild the controls. */
      load(rawModel: unknown): Promise<void>;
      /** Resolve after one render cycle has painted (settle before screenshot). */
      nextFrame(): Promise<void>;
    };
  }
}
