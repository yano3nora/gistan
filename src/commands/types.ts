import type { Runner } from "../core/proc.ts";

export type CommandName =
  | "new"
  | "search"
  | "grep"
  | "edit"
  | "list"
  | "rm"
  | "publish"
  | "unpublish"
  | "pull"
  | "status"
  | "import"
  | "root";

export interface CommandContext {
  readonly stdout: Pick<typeof Deno.stdout, "write">;
  readonly stderr: Pick<typeof Deno.stderr, "write">;
  /** External command boundary; tests inject a fake to avoid touching gh/git. */
  readonly runner: Runner;
  /** Path to config.toml; injected so tests never read or write the real one. */
  readonly configPath: string;
  /** User home directory; used for the default gist repo location. */
  readonly home: string;
  /** Interactive yes/no gate before destructive actions; injected for tests. */
  readonly confirm: (message: string) => Promise<boolean>;
  /** $EDITOR (fallback "vi"); vim-family names get line-jump / read-only flags. */
  readonly editor: string;
}

export interface CommandArgs {
  readonly name: CommandName;
  readonly args: readonly string[];
}

export type CommandHandler = (
  command: CommandArgs,
  context: CommandContext,
) => Promise<number> | number;

export async function writeText(
  stream: Pick<typeof Deno.stdout, "write"> | Pick<typeof Deno.stderr, "write">,
  text: string,
): Promise<void> {
  await stream.write(new TextEncoder().encode(text));
}
