import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { loadConfig } from "../core/config.ts";
import { parseDescription, slugify } from "../core/description.ts";
import { checkDeps, DEPS } from "../core/deps.ts";
import type { GistSummary } from "../core/gh.ts";
import { getGistFiles, listOwnGistSummaries } from "../core/gh.ts";
import { contentHash } from "../core/snippets.ts";
import type { SnippetEntry, State } from "../core/state.ts";
import { loadState, saveState } from "../core/state.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const out = (text: string) => writeText(context.stdout, text);
  const err = (text: string) => writeText(context.stderr, text);

  const flags = parseArgs([...command.args], { string: ["limit"] });
  const limit = flags.limit === undefined ? undefined : Number(flags.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    await err("error: --limit must be a positive integer\n");
    return 2;
  }

  const config = await loadConfig(context.configPath);
  if (config === undefined) {
    await err("error: gistan is not initialized — run `gistan init`\n");
    return 1;
  }
  const repo = config.repo;

  // The scan is part of import's contract (SPEC-0001): refuse to start without it.
  const gitleaks = await checkDeps(context.runner, DEPS.filter((d) => d.name === "gitleaks"));
  if (gitleaks.present.length === 0) {
    await err("error: gitleaks is required for import — brew install gitleaks\n");
    return 1;
  }

  const summaries = await listOwnGistSummaries(
    context.runner,
    (page, total) => out(`fetching gist list… page ${page} (${total} so far)\n`),
  );
  const targets = limit === undefined ? summaries : summaries.slice(0, limit);
  await out(`importing ${targets.length} of ${summaries.length} gists\n`);

  let state = await loadState(repo);
  const importedIds = new Set(
    Object.values(state.snippets)
      .map((entry) => entry.gist?.id)
      .filter((id): id is string => id !== undefined && id !== null),
  );

  let imported = 0;
  let skipped = 0;
  let failed = 0;
  for (const [index, gist] of targets.entries()) {
    try {
      const result = await importOne(repo, state, importedIds, gist, context);
      if (result === "skipped") {
        skipped++;
      } else {
        state = result;
        // Saved per gist so an interrupted run resumes where it left off.
        await saveState(repo, state);
        importedIds.add(gist.id);
        imported++;
      }
    } catch (error) {
      failed++;
      const reason = error instanceof Error ? error.message : String(error);
      await err(`warn: failed to import ${gist.id}: ${reason}\n`);
    }
    const done = index + 1;
    if (done % 25 === 0 || done === targets.length) {
      await out(`progress: ${done}/${targets.length}\n`);
    }
  }
  await out(`done: ${imported} imported, ${skipped} skipped, ${failed} failed\n`);

  const scanCode = await scanForSecrets(repo, context, out, err);
  if (scanCode !== 0) {
    return scanCode;
  }
  if (failed > 0) {
    await err(
      "warn: some gists failed — rerun `gistan import` to retry (already-imported ones are skipped)\n",
    );
    return 1;
  }
  await out("ok: secret scan passed — review the files, then commit\n");
  return 0;
}

async function importOne(
  repo: string,
  state: State,
  importedIds: ReadonlySet<string>,
  gist: GistSummary,
  context: CommandContext,
): Promise<State | "skipped"> {
  if (importedIds.has(gist.id)) {
    return "skipped";
  }
  const { tags, title } = parseDescription(gist.description);
  const files = (await getGistFiles(context.runner, gist.id)).filter((file) => {
    if (file.truncated === true || file.content === undefined) {
      throw new Error(`file ${file.filename} is truncated (>1MB) — import it manually`);
    }
    return true;
  });
  if (files.length === 0) {
    throw new Error("gist has no files");
  }

  if (files.length === 1) {
    const file = files[0];
    const relPath = await allocateFilePath(repo, file.filename, gist.id);
    await Deno.writeTextFile(join(repo, relPath), file.content ?? "");
    const entry: SnippetEntry = {
      tags,
      gist: {
        id: gist.id,
        visibility: gist.public ? "public" : "secret",
        synced_hash: await contentHash(new TextEncoder().encode(file.content ?? "")),
        remote_updated_at: gist.updated_at,
      },
    };
    return { version: 1, snippets: { ...state.snippets, [relPath]: entry } };
  }

  // Multi-file gists are kept as a directory for reading/searching only (v1),
  // without index entries. The id suffix makes the path self-identifying and
  // deterministic, so re-runs simply overwrite the same directory (idempotent).
  const slug = slugify(title);
  const dirRel = `snippets/${slug === "" ? "gist" : slug}--${gist.id.slice(0, 8)}`;
  await Deno.mkdir(join(repo, dirRel), { recursive: true });
  for (const file of files) {
    await Deno.writeTextFile(join(repo, dirRel, file.filename), file.content ?? "");
  }
  return state;
}

/**
 * Duplicate gist filenames are common across hundreds of gists; collisions get
 * a deterministic `--<gist id prefix>` suffix, so re-runs map to the same path.
 */
async function allocateFilePath(repo: string, filename: string, id: string): Promise<string> {
  const base = `snippets/${filename}`;
  if (!(await exists(join(repo, base)))) {
    return base;
  }
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : "";
  return `snippets/${stem}--${id.slice(0, 8)}${ext}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

/** gitleaks exit code 1 = leaks found; anything else non-zero = tool failure. */
async function scanForSecrets(
  repo: string,
  context: CommandContext,
  out: (text: string) => Promise<void>,
  err: (text: string) => Promise<void>,
): Promise<number> {
  await out("running secret scan (gitleaks)…\n");
  const scan = await context.runner("gitleaks", ["dir", repo, "--no-banner"]);
  if (scan.code === 0) {
    return 0;
  }
  const report = `${scan.stdout}\n${scan.stderr}`.trim();
  if (report !== "") {
    await err(`${report}\n`);
  }
  await err(
    "error: potential secrets detected — do NOT commit. Mask or remove them, then rerun `gistan import`\n",
  );
  return 1;
}
