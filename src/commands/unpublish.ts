import { deleteGist, gistUrl } from "../core/gh.ts";
import { loadState, saveState } from "../core/state.ts";
import { pickFile, requireConfig } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";
export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const out = (t: string) => writeText(context.stdout, t);
  const err = (t: string) => writeText(context.stderr, t);
  let target = command.args.at(0);
  const config = await requireConfig(context);
  if (!config) return 1;
  if (!target) {
    const picked = await pickFile(context, config.repo, "");
    if (picked.failed) return 1;
    target = picked.path;
    if (!target) return 0;
  }
  const dir = target.replace(/^gists\//, "").split("/")[0];
  const state = await loadState(config.repo);
  const entry = state.gists[dir];
  if (!entry) {
    await err(`error: ${dir} is not published\n`);
    return 1;
  }
  if (
    !(await context.confirm(
      `Unpublish ${dir}? The gist ${
        gistUrl(entry.id)
      } is deleted — its URL dies and comments/forks are lost.`,
    ))
  ) {
    await err("aborted\n");
    return 1;
  }
  try {
    await deleteGist(context.runner, entry.id);
  } catch (e) {
    await err(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const gists = { ...state.gists };
  delete gists[dir];
  await saveState(config.repo, { version: 2, gists });
  await out(`ok: unpublished ${dir} (local files kept)\n`);
  return 0;
}
