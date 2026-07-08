import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { slugify } from "../core/description.ts";
import { checkDeps, DEPS } from "../core/deps.ts";
import type { GistSummary } from "../core/gh.ts";
import { getGistFiles, listOwnGistSummaries } from "../core/gh.ts";
import { contentHash, DESCRIPTION_FILE, textHash } from "../core/snippets.ts";
import type { State } from "../core/state.ts";
import { loadState, saveState } from "../core/state.ts";
import { exists, requireConfig } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const out = (t: string) => writeText(context.stdout, t);
  const err = (t: string) => writeText(context.stderr, t);
  const flags = parseArgs([...command.args], { string: ["limit"] });
  const limit = flags.limit === undefined ? undefined : Number(flags.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    await err("error: --limit must be a positive integer\n");
    return 2;
  }
  const config = await requireConfig(context);
  if (!config) return 1;
  const gitleaks = await checkDeps(context.runner, DEPS.filter((d) => d.name === "gitleaks"));
  if (gitleaks.present.length === 0) {
    await err("error: gitleaks is required for import — brew install gitleaks\n");
    return 1;
  }
  const summaries = await listOwnGistSummaries(
    context.runner,
    (p, t) => out(`fetching gist list… page ${p} (${t} so far)\n`),
  );
  const targets = limit === undefined ? summaries : summaries.slice(0, limit);
  let state = await loadState(config.repo);
  const importedIds = new Set(Object.values(state.gists).map((e) => e.id));
  let imported = 0, skipped = 0, failed = 0;
  for (const gist of targets) {
    try {
      const r = await importOne(config.repo, state, importedIds, gist, context, err);
      if (r === "skipped") skipped++;
      else {
        state = r;
        await saveState(config.repo, state);
        importedIds.add(gist.id);
        imported++;
      }
    } catch (e) {
      failed++;
      await err(
        `warn: failed to import ${gist.id}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
  await out(`done: ${imported} imported, ${skipped} skipped, ${failed} failed\n`);
  const scan = await context.runner("gitleaks", ["dir", config.repo, "--no-banner"]);
  if (scan.code !== 0) {
    await err(`${scan.stdout}${scan.stderr}\nerror: potential secrets detected — do NOT commit\n`);
    return 1;
  }
  return failed > 0 ? 1 : 0;
}

async function importOne(
  repo: string,
  state: State,
  importedIds: ReadonlySet<string>,
  gist: GistSummary,
  context: CommandContext,
  err: (t: string) => Promise<void>,
): Promise<State | "skipped"> {
  if (importedIds.has(gist.id)) return "skipped";
  const files = await getGistFiles(context.runner, gist.id);
  if (files.some((f) => f.filename === DESCRIPTION_FILE)) {
    await err(`warn: ${gist.id} contains reserved ${DESCRIPTION_FILE}; skipped\n`);
    return "skipped";
  }
  if (files.length === 0) throw new Error("gist has no files");
  const dir = await allocateDir(repo, state, gist.description, gist.id, context);
  if (dir === undefined) return "skipped";
  await Deno.mkdir(join(repo, "gists", dir), { recursive: true });
  const hashes: Record<string, string> = {};
  for (const f of files) {
    if (f.content === undefined || f.truncated) {
      throw new Error(`file ${f.filename} is truncated (>1MB) — import it manually`);
    }
    await Deno.writeTextFile(join(repo, "gists", dir, f.filename), f.content);
    hashes[f.filename] = await contentHash(new TextEncoder().encode(f.content));
  }
  const desc = gist.description.trim();
  if (desc !== "") await Deno.writeTextFile(join(repo, "gists", dir, DESCRIPTION_FILE), desc);
  return {
    version: 2,
    gists: {
      ...state.gists,
      [dir]: {
        id: gist.id,
        visibility: gist.public ? "public" : "secret",
        remote_updated_at: gist.updated_at,
        synced_description_hash: desc === "" ? null : await textHash(desc),
        files: hashes,
      },
    },
  };
}

async function allocateDir(
  repo: string,
  state: State,
  description: string,
  id: string,
  context: CommandContext,
): Promise<string | undefined> {
  const base = slugify(description) || `gist--${id.slice(0, 8)}`;
  if (!(await exists(join(repo, "gists", base)))) return base;
  if (!state.gists[base]) {
    if (await context.confirm(`gists/${base} already exists and is not indexed. Override it?`)) {
      await Deno.remove(join(repo, "gists", base), { recursive: true });
      return base;
    }
    return undefined;
  }
  const suffixed = `${base}--${id.slice(0, 8)}`;
  if (!(await exists(join(repo, "gists", suffixed)))) return suffixed;
  if (!state.gists[suffixed]) {
    if (
      await context.confirm(`gists/${suffixed} already exists and is not indexed. Override it?`)
    ) {
      await Deno.remove(join(repo, "gists", suffixed), { recursive: true });
      return suffixed;
    }
  }
  return undefined;
}
