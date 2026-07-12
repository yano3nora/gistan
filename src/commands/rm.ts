import { join } from "@std/path";
import { deleteGist, gistUrl, updateGist } from "../core/gh.ts";
import { readGistFiles } from "../core/snippets.ts";
import { loadState, saveState } from "../core/state.ts";
import { exists, pickFile, requireConfig } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";
export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const out = (t: string) => writeText(context.stdout, t);
  const err = (t: string) => writeText(context.stderr, t);
  const config = await requireConfig(context);
  if (!config) return 1;
  let rel = command.args.at(0);
  if (!rel) {
    const p = await pickFile(context, config.repo, "");
    if (p.failed) return 1;
    rel = p.path;
    if (!rel) return 0;
  }
  if (rel.startsWith("stars/")) {
    await err("error: stars/ is a read-only mirror cache\n");
    return 1;
  }
  if (!rel.startsWith("gists/")) rel = `gists/${rel}`;
  // Exactly gists/<dir>/<filename>: a nested pick (gists/a/b/c.md) would
  // otherwise resolve "b" as the filename, stat the directory, and crash on
  // the non-recursive Deno.remove — nested files are unmanaged (SPEC-0001).
  const segments = rel.split("/");
  if (segments.length !== 3 || !segments[1] || !segments[2]) {
    await err("error: choose a file under gists/<dir>/\n");
    return 1;
  }
  const [, dir, file] = segments;
  const path = join(config.repo, "gists", dir, file);
  if (!(await exists(path))) {
    await err(`error: ${rel} not found\n`);
    return 1;
  }
  const state = await loadState(config.repo);
  const entry = state.gists[dir];
  if (!(await context.confirm(`Delete ${rel}?`))) {
    await err("aborted\n");
    return 1;
  }
  const remaining = Object.keys(await readGistFiles(config.repo, dir)).filter((f) => f !== file);
  if (entry) {
    if (remaining.length === 0) {
      if (
        await context.confirm(`This is the last gist file. Delete gist ${gistUrl(dir)} too?`)
      ) {
        await deleteGist(context.runner, dir);
        const gists = { ...state.gists };
        delete gists[dir];
        await saveState(config.repo, { version: 3, gists, locals: state.locals });
        await out("ok: gist deleted\n");
      }
    } else if (await context.confirm(`Also delete ${file} from gist ${gistUrl(dir)}?`)) {
      const updated = await updateGist(context.runner, dir, { files: { [file]: null } });
      const files = { ...entry.files };
      delete files[file];
      // Keep index byte-hash state aligned with the PATCH response; otherwise the next
      // status incorrectly reports local drift/conflict for the already-deleted file.
      await saveState(config.repo, {
        version: 3,
        gists: {
          ...state.gists,
          [dir]: {
            ...entry,
            remote_updated_at: updated.updated_at,
            files,
          },
        },
        locals: state.locals,
      });
    }
  }
  await Deno.remove(path);
  try {
    for await (const _e of Deno.readDir(join(config.repo, "gists", dir))) return 0;
    await Deno.remove(join(config.repo, "gists", dir));
    // The dir is gone; a local description would otherwise dangle in the index.
    if (state.locals[dir]) {
      const current = await loadState(config.repo);
      const locals = { ...current.locals };
      delete locals[dir];
      await saveState(config.repo, { version: 3, gists: current.gists, locals });
    }
  } catch { /* ignore */ }
  return 0;
}
