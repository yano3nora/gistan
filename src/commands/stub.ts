import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

export async function notImplemented(
  command: CommandArgs,
  context: CommandContext,
): Promise<number> {
  await writeText(context.stderr, `error: ${command.name} is not implemented yet\n`);
  return 1;
}
