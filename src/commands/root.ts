import { requireConfig } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

/** Prints the repo path for shell interop: `cd $(gistan root)`. */
export async function run(_command: CommandArgs, context: CommandContext): Promise<number> {
  const config = await requireConfig(context);
  if (config === undefined) {
    return 1;
  }
  await writeText(context.stdout, `${config.repo}\n`);
  return 0;
}
