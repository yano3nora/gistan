import { join } from "@std/path";
import type { CommandContext } from "./commands/types.ts";
import type { Runner } from "./core/proc.ts";

/**
 * In-memory CommandContext for tests: captures stdout/stderr as strings and
 * isolates the config file under the given (temporary) home directory.
 */
export function memoryContext(runner: Runner, home: string) {
  let stdout = "";
  let stderr = "";
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
  };
  return {
    context,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}
