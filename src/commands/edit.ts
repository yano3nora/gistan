import { openEditor, pickFile, requireConfig } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const config = await requireConfig(context);
  if (config === undefined) {
    return 1;
  }
  const { path, failed } = await pickFile(context, config.repo, command.args.join(" "));
  if (failed) {
    return 1;
  }
  if (path === undefined) {
    return 0;
  }
  return await openEditor(context, config.repo, path);
}
