import { join } from "@std/path";
import { deleteGist, gistUrl } from "../core/gh.ts";
import { newLocalId, parseGistTarget } from "../core/ids.ts";
import { loadState, saveState } from "../core/state.ts";
import { exists, requireConfig } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

const USAGE = "usage: gistan unpublish <id|url>\n" +
  "(grab an id/url from `gistan search` with ctrl-y)\n";

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const out = (t: string) => writeText(context.stdout, t);
  const err = (t: string) => writeText(context.stderr, t);
  const target = command.args.at(0);
  const id = target === undefined ? "" : parseGistTarget(target);
  if (id === "") {
    await err(USAGE);
    return 2;
  }
  const config = await requireConfig(context);
  if (!config) return 1;
  const state = await loadState(config.repo);
  const entry = state.gists[id];
  if (!entry) {
    await err(`error: ${id} is not a published gist (see gistan list --published)\n`);
    return 1;
  }
  if (
    !(await context.confirm(
      `Unpublish ${gistUrl(id)}? The gist is deleted — its URL dies and comments/forks are lost.`,
    ))
  ) {
    await err("aborted\n");
    return 1;
  }
  try {
    await deleteGist(context.runner, id);
  } catch (e) {
    await err(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const gists = { ...state.gists };
  delete gists[id];
  const locals = { ...state.locals };
  // The old id is a dangling URL once the gist is deleted, so the local dir
  // moves to a fresh local id instead of squatting on it (ADR-0003).
  let movedTo: string | undefined;
  try {
    if (await exists(join(config.repo, "gists", id))) {
      do {
        movedTo = newLocalId((candidate) => candidate in gists || candidate in locals);
      } while (await exists(join(config.repo, "gists", movedTo)));
      await Deno.rename(join(config.repo, "gists", id), join(config.repo, "gists", movedTo));
      if (entry.description !== "") locals[movedTo] = { description: entry.description };
    }
    await saveState(config.repo, { version: 3, gists, locals });
  } catch (e) {
    // The remote delete already happened; a failure past that point must
    // hand the user the exact repair, not leave a stale index entry silently.
    await err(
      `error: gist ${id} was deleted remotely but updating the local repo failed: ${
        e instanceof Error ? e.message : String(e)
      }\nrun gistan status --fix to unlink the stale index entry\n`,
    );
    return 1;
  }
  await out(
    movedTo === undefined
      ? `ok: unpublished ${id} (no local dir)\n`
      : `ok: unpublished — local files kept at gists/${movedTo} (id: ${movedTo})\n`,
  );
  return 0;
}
