import { parseArgs } from "@std/cli/parse-args";
import { dirname } from "@std/path";
import { copyToClipboard } from "../core/clipboard.ts";
import { createGist, deleteGist, type GistFilesPayload, gistUrl, updateGist } from "../core/gh.ts";
import { reconcile } from "../core/reconcile.ts";
import {
  contentHash,
  DESCRIPTION_FILE,
  readDescription,
  readGistFiles,
  scanGistDirs,
  textHash,
} from "../core/snippets.ts";
import type { GistIndexEntry, Visibility } from "../core/state.ts";
import { loadState, saveState } from "../core/state.ts";
import { pickFile, requireConfig } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const out = (text: string) => writeText(context.stdout, text);
  const err = (text: string) => writeText(context.stderr, text);
  const flags = parseArgs([...command.args], { boolean: ["secret", "public"] });
  let target = flags._.map(String).at(0);
  if (flags.secret && flags.public) {
    await err("error: --secret and --public are mutually exclusive\n");
    return 2;
  }
  const config = await requireConfig(context);
  if (!config) return 1;
  if (!target) {
    const picked = await pickFile(context, config.repo, "");
    if (picked.failed) return 1;
    target = picked.path;
    if (!target) return 0;
  }
  const dir = targetToDir(target);
  const scan = await scanGistDirs(config.repo);
  if (scan.nestedFiles.some((p) => p.startsWith(`gists/${dir}/`))) {
    await err(`error: gists/${dir} contains nested files; gist filenames cannot contain /\n`);
    return 1;
  }
  const local = scan.dirs.get(dir);
  if (!local) {
    await err(`error: gists/${dir} not found\n`);
    return 1;
  }
  const fileCount = Object.keys(local.files).length;
  if (fileCount === 0) {
    await err(
      `error: gists/${dir} has no publishable files (${DESCRIPTION_FILE} is metadata only)\n`,
    );
    return 1;
  }
  if (
    !(await context.confirm(
      `Publish ${dir} as one gist (${fileCount} files)? ${DESCRIPTION_FILE} is reserved and will not be uploaded.`,
    ))
  ) {
    await err("aborted\n");
    return 1;
  }
  const state = await loadState(config.repo);
  const current = state.gists[dir];
  // Publish also goes through the shared reconcile engine so drift semantics stay aligned with status/pull.
  const judgement = reconcile(scan.dirs, state).find((item) => item.dirname === dir);
  if (judgement?.condition === "dir-missing") {
    await err(`error: gists/${dir} is missing despite an index entry\n`);
    return 1;
  }
  const description = await readDescription(config.repo, dir);
  const allFiles = await readGistFiles(config.repo, dir);
  let link: GistIndexEntry;
  try {
    if (!current) {
      // Safe default: creating public must be an explicit opt-in (--public).
      const visibility: Visibility = flags.public ? "public" : "secret";
      const created = await createGist(context.runner, {
        description,
        public: visibility === "public",
        files: allFiles,
      });
      link = await indexEntry(created.id, visibility, created.updated_at, description, allFiles);
      await out(`ok: published (${visibility}) ${gistUrl(link.id)}\n`);
    } else {
      const desired: Visibility = flags.secret
        ? "secret"
        : flags.public
        ? "public"
        : current.visibility;
      if (desired !== current.visibility) {
        if (
          !(await context.confirm(
            `Changing visibility to ${desired} deletes and recreates the gist: URL changes and comments/forks are lost. Continue?`,
          ))
        ) {
          await err("aborted: visibility unchanged\n");
          return 1;
        }
        await deleteGist(context.runner, current.id);
        const created = await createGist(context.runner, {
          description,
          public: desired === "public",
          files: allFiles,
        });
        link = await indexEntry(created.id, desired, created.updated_at, description, allFiles);
        await out(
          `ok: recreated as ${desired}\nold: ${gistUrl(current.id)} (dead)\nnew: ${
            gistUrl(link.id)
          }\n`,
        );
      } else {
        const payload = await diffPayload(current.files, allFiles);
        const descHash = description === "" ? null : await textHash(description);
        const descriptionChanged = descHash !== current.synced_description_hash;
        if (Object.keys(payload).length === 0 && !descriptionChanged) {
          link = current;
          await out(`ok: already up to date ${gistUrl(link.id)}\n`);
        } else {
          const updated = await updateGist(context.runner, current.id, {
            files: payload,
            description: descriptionChanged ? description : undefined,
          });
          link = await indexEntry(
            current.id,
            current.visibility,
            updated.updated_at,
            description,
            allFiles,
          );
          await out(`ok: updated ${gistUrl(link.id)}\n`);
        }
      }
    }
  } catch (error) {
    await err(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  await saveState(config.repo, { version: 2, gists: { ...state.gists, [dir]: link } });
  if (await copyToClipboard(context.runner, gistUrl(link.id)) === "failed") {
    await writeText(context.stderr, "warn: clipboard copy failed\n");
  }
  return 0;
}

function targetToDir(target: string): string {
  const t = target.replace(/^gists\//, "");
  return t.includes("/") ? dirname(t) : t;
}
async function diffPayload(
  oldHashes: Readonly<Record<string, string>>,
  files: Readonly<Record<string, string>>,
): Promise<GistFilesPayload> {
  const payload: GistFilesPayload = {};
  for (const [name, content] of Object.entries(files)) {
    if (await contentHash(new TextEncoder().encode(content)) !== oldHashes[name]) {
      payload[name] = { content };
    }
  }
  for (const name of Object.keys(oldHashes)) if (!(name in files)) payload[name] = null;
  return payload;
}
async function indexEntry(
  id: string,
  visibility: Visibility,
  remote_updated_at: string,
  description: string,
  files: Readonly<Record<string, string>>,
): Promise<GistIndexEntry> {
  const hashes: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) {
    hashes[name] = await contentHash(new TextEncoder().encode(content));
  }
  return {
    id,
    visibility,
    remote_updated_at,
    synced_description_hash: description === "" ? null : await textHash(description),
    files: hashes,
  };
}
