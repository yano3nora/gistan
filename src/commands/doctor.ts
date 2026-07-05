import { basename, join } from "@std/path";
import { deleteGist, getGistFiles, gistUrl, listOwnGists } from "../core/gh.ts";
import { reconcile } from "../core/reconcile.ts";
import { contentHash, scanSnippets } from "../core/snippets.ts";
import type { SnippetEntry } from "../core/state.ts";
import { loadState, saveState } from "../core/state.ts";
import { requireConfig } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

/**
 * Interactive repair of index/local/remote inconsistencies. Detection comes
 * from the same reconcile engine as status/pull; doctor only decides what to
 * do about each finding, always gated by a confirm.
 */
export async function run(_command: CommandArgs, context: CommandContext): Promise<number> {
  const out = (text: string) => writeText(context.stdout, text);
  const err = (text: string) => writeText(context.stderr, text);

  const config = await requireConfig(context);
  if (config === undefined) {
    return 1;
  }

  let remote;
  try {
    remote = await listOwnGists(context.runner);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await err(`error: ${reason}\n`);
    return 1;
  }

  const files = await scanSnippets(config.repo);
  const state = await loadState(config.repo);
  const items = reconcile(files, state, remote);

  const snippets: Record<string, SnippetEntry> = { ...state.snippets };
  let fixed = 0;
  let left = 0;
  let pullNeeded = 0;
  let publishNeeded = 0;

  for (const item of items) {
    const short = item.path.replace(/^snippets\//, "");
    switch (item.condition) {
      case "file-missing": {
        const gist = item.entry?.gist;
        if (!gist) {
          if (await context.confirm(`${short}: file gone (never published). Forget the entry?`)) {
            delete snippets[item.path];
            fixed++;
          } else {
            left++;
          }
          break;
        }
        if (!remote.has(gist.id)) {
          if (
            await context.confirm(
              `${short}: file gone AND gist deleted upstream. Remove the stale entry?`,
            )
          ) {
            delete snippets[item.path];
            fixed++;
          } else {
            left++;
          }
          break;
        }
        if (
          await context.confirm(
            `${short}: file is gone but its gist lives (${
              gistUrl(gist.id)
            }). Restore the file from the gist?`,
          )
        ) {
          const content = await fetchContent(context, gist.id, basename(item.path));
          await Deno.writeTextFile(join(config.repo, item.path), content);
          snippets[item.path] = {
            tags: item.entry?.tags ?? [],
            gist: {
              ...gist,
              synced_hash: await contentHash(new TextEncoder().encode(content)),
              remote_updated_at: remote.get(gist.id)?.updated_at ?? gist.remote_updated_at,
            },
          };
          fixed++;
          await out(`ok: restored ${short}\n`);
        } else if (
          await context.confirm(`Delete the orphan gist and forget ${short}? (its URL dies)`)
        ) {
          await deleteGist(context.runner, gist.id);
          delete snippets[item.path];
          fixed++;
          await out(`ok: orphan gist deleted\n`);
        } else {
          left++;
        }
        break;
      }
      case "remote-deleted": {
        if (
          await context.confirm(
            `${short}: gist was deleted upstream. Unlink it (keep the local file)?`,
          )
        ) {
          snippets[item.path] = { tags: item.entry?.tags ?? [], gist: null };
          fixed++;
        } else {
          left++;
        }
        break;
      }
      case "remote-drift":
      case "conflict":
        pullNeeded++;
        break;
      case "local-drift":
        publishNeeded++;
        break;
    }
  }

  await saveState(config.repo, { version: 1, snippets });

  if (fixed === 0 && left === 0 && pullNeeded === 0 && publishNeeded === 0) {
    await out("ok: no issues found\n");
    return 0;
  }
  await out(`doctor: ${fixed} fixed, ${left} left as-is\n`);
  if (pullNeeded > 0) {
    await out(`${pullNeeded} snippet(s) have remote changes — run \`gistan pull\`\n`);
  }
  if (publishNeeded > 0) {
    await out(`${publishNeeded} snippet(s) have local changes — run \`gistan publish <path>\`\n`);
  }
  return 0;
}

async function fetchContent(
  context: CommandContext,
  gistId: string,
  name: string,
): Promise<string> {
  const files = await getGistFiles(context.runner, gistId);
  const file = files.find((f) => f.filename === name) ??
    (files.length === 1 ? files[0] : undefined);
  if (file === undefined || file.content === undefined || file.truncated === true) {
    throw new Error("cannot resolve the gist file content (renamed, multi-file, or truncated)");
  }
  return file.content;
}
