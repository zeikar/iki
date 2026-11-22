import { EDITOR_VERSION } from "@ikijs/editor";
import {
  IkiFormatError,
  parseIkiGenerator,
  type IkiGenerator,
} from "@ikijs/format";

/** Injected by tsup (and vitest) from this package's package.json version. */
declare const __MCP_VERSION__: string;

/** The environment variable a plugin names itself in, as `name@version`, when
 *  it launches the server: recorded as the model's `generator.plugin`. */
export const PLUGIN_ENV = "IKI_PLUGIN";

/**
 * What the tool server records in a model it writes: itself, the auto-rigger
 * it runs (the installed `@ikijs/editor`, which may be newer than the one it
 * was built against), and the plugin named in {@link PLUGIN_ENV}, if any. An
 * unset or empty variable names none; one that is no valid label throws an
 * `IkiFormatError` naming the variable.
 */
export function toolGenerator(
  env: Record<string, string | undefined> = process.env,
): IkiGenerator {
  const generator: IkiGenerator = {
    tool: `@ikijs/mcp@${__MCP_VERSION__}`,
    rigger: `@ikijs/editor@${EDITOR_VERSION}`,
  };
  const plugin = env[PLUGIN_ENV];
  if (plugin === undefined || plugin === "") return generator;
  try {
    return parseIkiGenerator({ ...generator, plugin });
  } catch (e) {
    if (!(e instanceof IkiFormatError)) throw e;
    throw new IkiFormatError(
      `the ${PLUGIN_ENV} environment variable is no label for a model: ${e.message}`,
    );
  }
}
