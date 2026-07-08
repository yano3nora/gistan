import { join } from "@std/path";
import { saveConfig } from "../core/config.ts";
import type { Runner } from "../core/proc.ts";
import { memoryContext } from "../testing.ts";

export const AT = "2026-07-08T00:00:00Z";
export const AT2 = "2026-07-09T00:00:00Z";

export async function fixture() {
  const home = await Deno.makeTempDir();
  const repo = join(home, "repo");
  await Deno.mkdir(join(repo, "gists"), { recursive: true });
  await Deno.mkdir(join(repo, ".gistan"), { recursive: true });
  await saveConfig(join(home, "config.toml"), { repo });
  return { home, repo };
}

export function okRunner(): Runner {
  return () => Promise.resolve({ code: 0, stdout: "", stderr: "" });
}

export { join, memoryContext };
