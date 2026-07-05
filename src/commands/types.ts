export type CommandName = "init" | "import" | "search" | "publish" | "status";

export interface CommandContext {
  readonly stdout: Pick<typeof Deno.stdout, "write">;
  readonly stderr: Pick<typeof Deno.stderr, "write">;
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
