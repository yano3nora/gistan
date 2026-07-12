import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { copyToClipboard } from "../core/clipboard.ts";
import type { Config } from "../core/config.ts";
import { createGist, deleteGist, gistUrl, updateGist } from "../core/gh.ts";
import { parseGistTarget } from "../core/ids.ts";
import { readGistFiles, scanGistDirs } from "../core/snippets.ts";
import type { GistIndexEntry, Visibility } from "../core/state.ts";
import { loadState, saveState } from "../core/state.ts";
import { diffPayload, hashFiles } from "../core/sync.ts";
import { requireConfig } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

const USAGE = "usage: gistan publish <id|url> [--secret|--public] [-d <desc>]\n" +
  "(grab an id/url from `gistan search` with ctrl-y)\n";

export interface PublishFlags {
  readonly public?: boolean;
  readonly secret?: boolean;
  readonly description?: string;
}

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const err = (text: string) => writeText(context.stderr, text);
  const flags = parseArgs([...command.args], {
    boolean: ["secret", "public"],
    string: ["d", "description"],
    alias: { d: "description" },
  });
  if (flags.secret && flags.public) {
    await err("error: --secret and --public are mutually exclusive\n");
    return 2;
  }
  // id / URL only (ADR-0003): dirnames are gist ids, and filename targeting is
  // ambiguous across gists — per-gist maintenance goes search (ctrl-y) → publish.
  const target = flags._.map(String).at(0);
  const dir = target === undefined ? "" : parseGistTarget(target);
  if (dir === "") {
    await err(USAGE);
    return 2;
  }
  const config = await requireConfig(context);
  if (!config) return 1;
  return await publishDir(context, config, dir, {
    public: flags.public,
    secret: flags.secret,
    description: flags.description,
  });
}

/**
 * Create-or-update a gist from gists/<dir>/. Shared with `new --publish`.
 * On first publish the dir is renamed local-id -> gist-id, keeping the
 * "published dirname = gist id" invariant (ADR-0003).
 */
export async function publishDir(
  context: CommandContext,
  config: Config,
  dir: string,
  flags: PublishFlags,
): Promise<number> {
  const out = (text: string) => writeText(context.stdout, text);
  const err = (text: string) => writeText(context.stderr, text);
  const scan = await scanGistDirs(config.repo);
  if (scan.nestedFiles.some((p) => p.startsWith(`gists/${dir}/`))) {
    await err(`error: gists/${dir} contains nested files; gist filenames cannot contain /\n`);
    return 1;
  }
  const state = await loadState(config.repo);
  const current = state.gists[dir];
  if (!scan.dirs.has(dir)) {
    if (current) {
      await err(
        `error: gists/${dir} is missing despite an index entry — run gistan status --fix\n`,
      );
    } else {
      await err(`error: no gist ${dir} and no dir gists/${dir}\n`);
    }
    return 1;
  }
  const allFiles = await readGistFiles(config.repo, dir);
  const names = Object.keys(allFiles).sort();
  if (names.length === 0) {
    await err(`error: gists/${dir} has no files\n`);
    return 1;
  }
  const description = flags.description ?? current?.description ??
    state.locals[dir]?.description ?? "";
  const desired: Visibility = flags.secret ? "secret" : flags.public
    ? "public"
    // Safe default: creating public must be an explicit opt-in (--public).
    : current?.visibility ?? "secret";

  // Light preview before the confirm: what exactly is about to go up.
  await out(`gists/${dir} (${names.length} file(s), ${desired}):\n`);
  for (const name of names) await out(`  ${name}${firstLineExcerpt(allFiles[name])}\n`);
  if (description !== "") await out(`description: ${description}\n`);

  let link: GistIndexEntry;
  let id: string;
  let movedFrom: string | undefined;
  // Old-visibility gist to delete LAST (visibility change is create-first:
  // a mid-flight failure leaves a recoverable duplicate, never a deleted-only
  // state — ADR-0001's failure-mode stance).
  let staleGistId: string | undefined;
  let action: "published" | "recreated" | "updated" | "up-to-date";
  try {
    if (!current) {
      if (!(await context.confirm(`Publish gists/${dir} as one ${desired} gist?`))) {
        await err("aborted\n");
        return 1;
      }
      const created = await createGist(context.runner, {
        description,
        public: desired === "public",
        files: allFiles,
      });
      id = created.id;
      movedFrom = dir;
      action = "published";
      link = {
        visibility: desired,
        description,
        remote_updated_at: created.updated_at,
        files: await hashFiles(allFiles),
      };
    } else if (desired !== current.visibility) {
      if (
        !(await context.confirm(
          `Changing visibility to ${desired} deletes and recreates the gist: URL changes and comments/forks are lost. Continue?`,
        ))
      ) {
        await err("aborted: visibility unchanged\n");
        return 1;
      }
      const created = await createGist(context.runner, {
        description,
        public: desired === "public",
        files: allFiles,
      });
      id = created.id;
      movedFrom = dir;
      staleGistId = dir;
      action = "recreated";
      link = {
        visibility: desired,
        description,
        remote_updated_at: created.updated_at,
        files: await hashFiles(allFiles),
      };
    } else {
      if (!(await context.confirm(`Update gist ${gistUrl(dir)}?`))) {
        await err("aborted\n");
        return 1;
      }
      id = dir;
      const payload = await diffPayload(current.files, allFiles);
      const descriptionChanged = flags.description !== undefined &&
        flags.description !== current.description;
      if (Object.keys(payload).length === 0 && !descriptionChanged) {
        link = current;
        action = "up-to-date";
      } else {
        const updated = await updateGist(context.runner, id, {
          files: payload,
          description: descriptionChanged ? description : undefined,
        });
        action = "updated";
        link = {
          visibility: current.visibility,
          description,
          remote_updated_at: updated.updated_at,
          files: await hashFiles(allFiles),
        };
      }
    }
  } catch (error) {
    await err(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  // Finalize locally (rename + index) BEFORE claiming success: a created gist
  // whose local switch fails must surface as an explicit inconsistency with
  // recovery steps, never as a quiet remote orphan behind an "ok:" line.
  if (action !== "up-to-date") {
    try {
      if (movedFrom !== undefined) {
        await Deno.rename(join(config.repo, "gists", movedFrom), join(config.repo, "gists", id));
      }
      const gists = { ...state.gists, [id]: link };
      if (movedFrom !== undefined) delete gists[movedFrom];
      if (staleGistId !== undefined) delete gists[staleGistId];
      const locals = { ...state.locals };
      if (movedFrom !== undefined) delete locals[movedFrom];
      await saveState(config.repo, { version: 3, gists, locals });
    } catch (error) {
      await err(
        `error: gist ${gistUrl(id)} exists remotely but finalizing locally failed: ${
          error instanceof Error ? error.message : String(error)
        }\nlocal files are under gists/${
          movedFrom ?? id
        } — fix the cause, then run gistan status --fix (or gistan import)\n`,
      );
      return 1;
    }
  }
  // Only now retire the old-visibility gist; a failure here is a duplicate
  // the user can see and delete, not data loss.
  let staleDeleted = false;
  if (staleGistId !== undefined) {
    try {
      await deleteGist(context.runner, staleGistId);
      staleDeleted = true;
    } catch (error) {
      await err(
        `warn: old gist ${gistUrl(staleGistId)} could not be deleted (${
          error instanceof Error ? error.message : String(error)
        }) — delete it manually\n`,
      );
    }
  }
  if (action === "published") {
    await out(`ok: published (${desired}) ${gistUrl(id)}\n`);
  } else if (action === "recreated") {
    await out(
      `ok: recreated as ${desired}\nold: ${gistUrl(staleGistId!)} ${
        staleDeleted ? "(dead)" : "(still exists)"
      }\nnew: ${gistUrl(id)}\n`,
    );
  } else if (action === "updated") {
    await out(`ok: updated ${gistUrl(id)}\n`);
  } else {
    await out(`ok: already up to date ${gistUrl(id)}\n`);
  }
  if (movedFrom !== undefined) await out(`moved: gists/${movedFrom} -> gists/${id}\n`);
  if (await copyToClipboard(context.runner, gistUrl(id)) === "failed") {
    await err("warn: clipboard copy failed\n");
  }
  return 0;
}

/** First non-blank line, trimmed to ~60 chars (Array.from so CJK never splits). */
function firstLineExcerpt(content: string): string {
  const line = (content.split("\n").find((l) => l.trim() !== "") ?? "").trim();
  if (line === "") return "";
  const chars = Array.from(line);
  return `  ${chars.slice(0, 60).join("")}${chars.length > 60 ? "…" : ""}`;
}
