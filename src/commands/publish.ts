import { parseArgs } from "@std/cli/parse-args";
import { basename, join } from "@std/path";
import { loadConfig } from "../core/config.ts";
import { buildDescription } from "../core/description.ts";
import { createGist, deleteGist, gistUrl, updateGist } from "../core/gh.ts";
import { EXIT_COMMAND_NOT_FOUND } from "../core/proc.ts";
import { contentHash } from "../core/snippets.ts";
import type { GistLink, Visibility } from "../core/state.ts";
import { loadState, saveState } from "../core/state.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const out = (text: string) => writeText(context.stdout, text);
  const err = (text: string) => writeText(context.stderr, text);

  const flags = parseArgs([...command.args], {
    boolean: ["secret", "public"],
    string: ["description"],
  });
  const target = flags._.map(String).at(0);
  if (target === undefined) {
    await err("usage: gistan publish <path> [--secret|--public] [--description <text>]\n");
    return 2;
  }
  if (flags.secret && flags.public) {
    await err("error: --secret and --public are mutually exclusive\n");
    return 2;
  }

  const config = await loadConfig(context.configPath);
  if (config === undefined) {
    await err("error: gistan is not initialized — run `gistan init`\n");
    return 1;
  }

  const relPath = target.startsWith("snippets/") ? target : `snippets/${target}`;
  let content: string;
  try {
    content = await Deno.readTextFile(join(config.repo, relPath));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      await err(`error: ${relPath} not found in ${config.repo}\n`);
      return 1;
    }
    throw error;
  }

  const hash = await contentHash(new TextEncoder().encode(content));
  const state = await loadState(config.repo);
  const entry = state.snippets[relPath] ?? { tags: [], gist: null };
  const filename = basename(relPath);
  const description = flags.description ?? buildDescription(entry.tags, filename);

  let link: GistLink;
  try {
    if (entry.gist === null) {
      const visibility: Visibility = flags.secret ? "secret" : "public";
      const created = await createGist(context.runner, {
        description,
        public: visibility === "public",
        file: { filename, content },
      });
      link = {
        id: created.id,
        visibility,
        synced_hash: hash,
        remote_updated_at: created.updated_at,
      };
      await out(`ok: published (${visibility}) ${gistUrl(link.id)}\n`);
    } else {
      const current = entry.gist;
      // Omitted visibility flags mean "keep the current visibility" — an update
      // must never flip visibility implicitly (recreating changes the URL).
      const desired: Visibility = flags.secret
        ? "secret"
        : flags.public
        ? "public"
        : current.visibility;
      if (desired !== current.visibility) {
        const proceed = await context.confirm(
          `Changing visibility to ${desired} deletes and recreates the gist: ` +
            `the URL changes and comments/forks are lost. Continue?`,
        );
        if (!proceed) {
          await err("aborted: visibility unchanged\n");
          return 1;
        }
        await deleteGist(context.runner, current.id);
        const created = await createGist(context.runner, {
          description,
          public: desired === "public",
          file: { filename, content },
        });
        link = {
          id: created.id,
          visibility: desired,
          synced_hash: hash,
          remote_updated_at: created.updated_at,
        };
        await out(`ok: recreated as ${desired} — the URL has changed\n`);
        await out(`old: ${gistUrl(current.id)} (dead)\nnew: ${gistUrl(link.id)}\n`);
      } else if (hash === current.synced_hash && flags.description === undefined) {
        link = current;
        await out(`ok: already up to date ${gistUrl(link.id)}\n`);
      } else {
        const updated = await updateGist(context.runner, current.id, {
          file: { filename, content },
          description: flags.description,
        });
        link = { ...current, synced_hash: hash, remote_updated_at: updated.updated_at };
        await out(`ok: updated ${gistUrl(link.id)}\n`);
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await err(`error: ${reason}\n`);
    return 1;
  }

  await saveState(config.repo, {
    version: 1,
    snippets: { ...state.snippets, [relPath]: { tags: entry.tags, gist: link } },
  });
  await copyToClipboard(context, gistUrl(link.id));
  return 0;
}

/** Best-effort (macOS pbcopy). The URL is always printed, so failure is not an error. */
async function copyToClipboard(context: CommandContext, text: string): Promise<void> {
  const result = await context.runner("pbcopy", [], { stdin: text });
  if (result.code !== 0 && result.code !== EXIT_COMMAND_NOT_FOUND) {
    await writeText(context.stderr, "warn: clipboard copy failed\n");
  }
}
