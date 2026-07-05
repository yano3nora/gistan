export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly cwd?: string;
}

/**
 * External command execution boundary. Commands must spawn subprocesses only
 * through an injected Runner so tests can fake gh/git behavior without a network.
 */
export type Runner = (
  cmd: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<RunResult>;

/** POSIX convention for "command not found"; deps.ts relies on this to detect missing CLIs. */
export const EXIT_COMMAND_NOT_FOUND = 127;

export async function systemRunner(
  cmd: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  try {
    const output = await new Deno.Command(cmd, {
      args: [...args],
      cwd: options.cwd,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const decoder = new TextDecoder();
    return {
      code: output.code,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { code: EXIT_COMMAND_NOT_FOUND, stdout: "", stderr: `command not found: ${cmd}` };
    }
    throw error;
  }
}
