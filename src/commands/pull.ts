import { join } from "@std/path";
import { getGist, listOwnGists } from "../core/gh.ts";
import { reconcile } from "../core/reconcile.ts";
import { contentHash, DESCRIPTION_FILE, scanGistDirs, textHash } from "../core/snippets.ts";
import { loadState, saveState } from "../core/state.ts";
import { FZF_ABORTED, FZF_NO_MATCH, requireConfig } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const out = (t: string) => writeText(context.stdout, t);
  const err = (t: string) => writeText(context.stderr, t);
  const config = await requireConfig(context);
  if (!config) return 1;
  let remote;
  try {
    remote = await listOwnGists(context.runner);
  } catch (e) {
    await err(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  let state = await loadState(config.repo);
  let items = reconcile((await scanGistDirs(config.repo)).dirs, state, remote);
  const arg = command.args.at(0);
  if (arg) {
    const dir = arg.replace(/^gists\//, "").split("/")[0];
    items = items.filter((i) => i.dirname === dir);
  } else {
    const candidates = items.filter((i) =>
      i.condition === "remote-drift" || i.condition === "conflict"
    );
    if (candidates.length === 0) {
      await out("no remote drift\n");
      return 0;
    }
    const picked = await pickRemoteDriftDir(context, candidates.map((i) => i.dirname));
    if (picked.failed) return 1;
    if (!picked.dirname) return 0;
    items = candidates.filter((i) => i.dirname === picked.dirname);
  }
  let pulled = 0;
  for (const item of items) {
    if (!item.entry) continue;
    if (
      item.condition === "conflict" &&
      !(await context.confirm(`Overwrite local ${item.dirname} with remote gist?`))
    ) continue;
    const gist = await getGist(context.runner, item.entry.id);
    const dirPath = join(config.repo, "gists", item.dirname);
    await Deno.mkdir(dirPath, { recursive: true });
    const remoteFileNames = new Set<string>();
    const hashes: Record<string, string> = {};
    for (const f of gist.files) {
      if (f.content === undefined || f.truncated) {
        await err(`warn: ${item.dirname}/${f.filename}: truncated; skipped\n`);
        continue;
      }
      remoteFileNames.add(f.filename);
      await Deno.writeTextFile(join(dirPath, f.filename), f.content);
      hashes[f.filename] = await contentHash(new TextEncoder().encode(f.content));
    }
    for await (const local of Deno.readDir(dirPath)) {
      if (!local.isFile || local.name === DESCRIPTION_FILE || local.name === ".gitkeep") continue;
      if (!remoteFileNames.has(local.name)) await Deno.remove(join(dirPath, local.name));
    }
    const description = gist.description.trim();
    if (description === "") {
      try {
        await Deno.remove(join(dirPath, DESCRIPTION_FILE));
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
    } else {
      await Deno.writeTextFile(join(dirPath, DESCRIPTION_FILE), description);
    }
    state = {
      version: 2,
      gists: {
        ...state.gists,
        [item.dirname]: {
          ...item.entry,
          remote_updated_at: gist.updated_at ||
            remote.get(item.entry.id)?.updated_at ||
            item.entry.remote_updated_at,
          synced_description_hash: description === "" ? null : await textHash(description),
          files: hashes,
        },
      },
    };
    await saveState(config.repo, state);
    pulled++;
    await out(`pulled: ${item.dirname}\n`);
  }
  await out(`done: ${pulled} pulled\n`);
  return 0;
}

async function pickRemoteDriftDir(
  context: CommandContext,
  dirs: readonly string[],
): Promise<{ dirname?: string; failed: boolean }> {
  const picked = await context.runner("fzf", ["--prompt", "pull> "], {
    stdin: `${dirs.join("\n")}\n`,
  });
  if (picked.code === FZF_NO_MATCH || picked.code === FZF_ABORTED) return { failed: false };
  if (picked.code !== 0) {
    await writeText(
      context.stderr,
      `error: fzf failed: ${picked.stderr.trim() || `exit ${picked.code}`}\n`,
    );
    return { failed: true };
  }
  const dirname = picked.stdout.split("\n").at(0)?.trim();
  return { dirname: dirname === "" ? undefined : dirname, failed: false };
}
