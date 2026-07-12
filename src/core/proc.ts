export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly cwd?: string;
  /** Piped to the child's stdin; used for `gh api --input -` bodies and clipboard tools. */
  readonly stdin?: string;
  /**
   * Inherit all stdio from the parent (fzf UI, $EDITOR sessions). stdout/stderr
   * come back empty; only the exit code is meaningful. Ignores `stdin`.
   */
  readonly interactive?: boolean;
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
    if (options.interactive === true) {
      const status = await new Deno.Command(cmd, {
        args: [...args],
        cwd: options.cwd,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }).spawn().status;
      return { code: status.code, stdout: "", stderr: "" };
    }
    const command = new Deno.Command(cmd, {
      args: [...args],
      cwd: options.cwd,
      stdin: options.stdin === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
    });
    let output: Deno.CommandOutput;
    if (options.stdin === undefined) {
      output = await command.output();
    } else {
      const child = command.spawn();
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(options.stdin));
      await writer.close();
      output = await child.output();
    }
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
