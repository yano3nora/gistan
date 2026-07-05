import { parseArgs } from "@std/cli/parse-args";
import { basename, join } from "@std/path";
import { getGistFiles, listOwnGists } from "../core/gh.ts";
import type { ReconcileItem } from "../core/reconcile.ts";
import { reconcile } from "../core/reconcile.ts";
import { contentHash, scanSnippets } from "../core/snippets.ts";
import type { GistLink, SnippetEntry } from "../core/state.ts";
import { loadState, saveState } from "../core/state.ts";
import { requireConfig, toRelPath } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const out = (text: string) => writeText(context.stdout, text);
  const err = (text: string) => writeText(context.stderr, text);

  const flags = parseArgs([...command.args], { boolean: ["stars"] });
  if (flags.stars) {
    await err("error: --stars arrives with the star command (v3)\n");
    return 2;
  }

  const config = await requireConfig(context);
  if (config === undefined) {
    return 1;
  }

  // Unlike status, pull is meaningless without the remote — fail loudly.
  let remote;
  try {
    remote = await listOwnGists(context.runner);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await err(`error: ${reason}\n`);
    return 1;
  }

  const files = await scanSnippets(config.repo);
  let state = await loadState(config.repo);
  let items = reconcile(files, state, remote);

  const filter = flags._.map(String).at(0);
  if (filter !== undefined) {
    const rel = toRelPath(filter);
    items = items.filter((item) => item.path === rel);
    if (items.length === 0) {
      await err(`error: no snippet matches "${filter}"\n`);
      return 1;
    }
  }

  let pulled = 0;
  let keptLocal = 0;
  let localAhead = 0;
  let deleted = 0;
  for (const item of items) {
    const short = item.path.replace(/^snippets\//, "");
    try {
      switch (item.condition) {
        case "remote-drift": {
          state = await applyRemote(config.repo, state, item, remote, context);
          await saveState(config.repo, state);
          pulled++;
          await out(`pulled: ${short}\n`);
          break;
        }
        case "conflict": {
          const content = await fetchRemoteContent(context, item);
          await showDiff(context, join(config.repo, item.path), content);
          if (await context.confirm(`Overwrite local ${short} with the remote version?`)) {
            state = await applyRemote(config.repo, state, item, remote, context, content);
            await saveState(config.repo, state);
            pulled++;
            await out(`pulled: ${short} (conflict resolved as remote)\n`);
          } else {
            keptLocal++;
            await out(`skipped: ${short} (local kept — \`gistan publish ${short}\` to push it)\n`);
          }
          break;
        }
        case "remote-deleted": {
          deleted++;
          await err(`warn: ${short}: gist deleted upstream — run \`gistan doctor\`\n`);
          break;
        }
        case "local-drift": {
          localAhead++;
          break;
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await err(`warn: ${short}: ${reason}\n`);
    }
  }

  await out(
    `done: ${pulled} pulled, ${keptLocal} conflict(s) kept local, ` +
      `${localAhead} local-ahead (use publish), ${deleted} deleted upstream\n`,
  );
  return 0;
}

async function applyRemote(
  repo: string,
  state: { version: 1; snippets: Readonly<Record<string, SnippetEntry>> },
  item: ReconcileItem,
  remote: ReadonlyMap<string, { updated_at: string }>,
  context: CommandContext,
  prefetched?: string,
) {
  const gist = item.entry?.gist as GistLink;
  const content = prefetched ?? (await fetchRemoteContent(context, item));
  await Deno.writeTextFile(join(repo, item.path), content);
  const link: GistLink = {
    ...gist,
    synced_hash: await contentHash(new TextEncoder().encode(content)),
    remote_updated_at: remote.get(gist.id)?.updated_at ?? gist.remote_updated_at,
  };
  return {
    version: 1 as const,
    snippets: {
      ...state.snippets,
      [item.path]: { tags: item.entry?.tags ?? [], gist: link },
    },
  };
}

/** Picks the gist file matching the local basename (rename-tolerant for single-file gists). */
async function fetchRemoteContent(context: CommandContext, item: ReconcileItem): Promise<string> {
  const gist = item.entry?.gist as GistLink;
  const files = await getGistFiles(context.runner, gist.id);
  const name = basename(item.path);
  const file = files.find((f) => f.filename === name) ??
    (files.length === 1 ? files[0] : undefined);
  if (file === undefined || file.content === undefined || file.truncated === true) {
    throw new Error("cannot resolve the gist file content (renamed, multi-file, or truncated)");
  }
  return file.content;
}

/** Best-effort colored diff via `git diff --no-index`; exit 1 just means "differs". */
async function showDiff(context: CommandContext, localAbs: string, remoteContent: string) {
  const tmp = await Deno.makeTempFile({ suffix: ".remote" });
  try {
    await Deno.writeTextFile(tmp, remoteContent);
    const diff = await context.runner("git", ["diff", "--no-index", "--color", localAbs, tmp]);
    await writeText(context.stdout, diff.stdout);
  } finally {
    await Deno.remove(tmp);
  }
}
