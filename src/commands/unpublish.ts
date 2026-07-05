import { deleteGist, gistUrl } from "../core/gh.ts";
import { loadState, saveState } from "../core/state.ts";
import { requireConfig, toRelPath } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const out = (text: string) => writeText(context.stdout, text);
  const err = (text: string) => writeText(context.stderr, text);

  const target = command.args.at(0);
  if (target === undefined) {
    await err("usage: gistan unpublish <path>\n");
    return 2;
  }

  const config = await requireConfig(context);
  if (config === undefined) {
    return 1;
  }

  const relPath = toRelPath(target);
  const state = await loadState(config.repo);
  const entry = state.snippets[relPath];
  if (!entry?.gist) {
    await err(`error: ${relPath} is not published\n`);
    return 1;
  }

  const proceed = await context.confirm(
    `Unpublish ${relPath}? The gist ${gistUrl(entry.gist.id)} is deleted — ` +
      `its URL dies and comments/forks are lost.`,
  );
  if (!proceed) {
    await err("aborted\n");
    return 1;
  }

  try {
    await deleteGist(context.runner, entry.gist.id);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await err(`error: ${reason}\n`);
    return 1;
  }

  // The local file and its tags survive — only the publication is undone.
  await saveState(config.repo, {
    version: 1,
    snippets: { ...state.snippets, [relPath]: { tags: entry.tags, gist: null } },
  });
  await out(`ok: unpublished ${relPath} (local file kept)\n`);
  return 0;
}
