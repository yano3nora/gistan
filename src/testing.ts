import { join } from "@std/path";
import type { CommandContext } from "./commands/types.ts";
import type { Runner } from "./core/proc.ts";

/**
 * In-memory CommandContext for tests: captures stdout/stderr as strings and
 * isolates the config file under the given (temporary) home directory.
 */
export function memoryContext(
  runner: Runner,
  home: string,
  options: { confirmAnswer?: boolean | boolean[]; editor?: string } = {},
) {
  let stdout = "";
  let stderr = "";
  const confirms: string[] = [];
  const decoder = new TextDecoder();
  const context: CommandContext = {
    stdout: {
      write(chunk: Uint8Array): Promise<number> {
        stdout += decoder.decode(chunk, { stream: true });
        return Promise.resolve(chunk.byteLength);
      },
    },
    stderr: {
      write(chunk: Uint8Array): Promise<number> {
        stderr += decoder.decode(chunk, { stream: true });
        return Promise.resolve(chunk.byteLength);
      },
    },
    runner,
    configPath: join(home, "config.toml"),
    home,
    confirm(message: string): Promise<boolean> {
      confirms.push(message);
      // An array answers confirms in sequence (exhausted → true).
      const answer = Array.isArray(options.confirmAnswer)
        ? options.confirmAnswer[confirms.length - 1] ?? true
        : options.confirmAnswer ?? true;
      return Promise.resolve(answer);
    },
    editor: options.editor ?? "vi",
  };
  return {
    context,
    confirms,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}
