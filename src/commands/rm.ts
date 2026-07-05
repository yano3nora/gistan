import { join } from "@std/path";
import { deleteGist, gistUrl } from "../core/gh.ts";
import { loadState, saveState } from "../core/state.ts";
import { exists, pickFile, requireConfig, toRelPath } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const out = (text: string) => writeText(context.stdout, text);
  const err = (text: string) => writeText(context.stderr, text);

  const config = await requireConfig(context);
  if (config === undefined) {
    return 1;
  }

  const arg = command.args.at(0);
  let relPath: string | undefined = arg === undefined ? undefined : toRelPath(arg);
  if (relPath === undefined) {
    const pick = await pickFile(context, config.repo, "");
    if (pick.failed) {
      return 1;
    }
    relPath = pick.path;
    if (relPath === undefined) {
      return 0;
    }
  }
  if (relPath.startsWith("stars/")) {
    await err("error: stars/ is a read-only mirror cache — it comes back on star sync\n");
    return 1;
  }

  const state = await loadState(config.repo);
  const entry = state.snippets[relPath];
  const fileExists = await exists(join(config.repo, relPath));
  if (!fileExists && entry === undefined) {
    await err(`error: ${relPath} not found\n`);
    return 1;
  }

  if (!(await context.confirm(`Delete ${relPath}?`))) {
    await err("aborted\n");
    return 1;
  }
  if (fileExists) {
    await Deno.remove(join(config.repo, relPath));
  }

  if (entry?.gist) {
    const alsoRemote = await context.confirm(
      `Also delete the gist ${gistUrl(entry.gist.id)}? (its URL dies)`,
    );
    if (alsoRemote) {
      try {
        await deleteGist(context.runner, entry.gist.id);
        await out("ok: gist deleted\n");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await err(`error: ${reason} — the index entry is kept; run \`gistan doctor\`\n`);
        return 1;
      }
    } else {
      await out(`gist kept (now unmanaged by gistan): ${gistUrl(entry.gist.id)}\n`);
    }
  }

  if (entry !== undefined) {
    const snippets = { ...state.snippets };
    delete snippets[relPath];
    await saveState(config.repo, { version: 1, snippets });
  }
  await out(`ok: removed ${relPath}\n`);
  return 0;
}
