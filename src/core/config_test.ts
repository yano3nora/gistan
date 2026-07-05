import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { defaultConfigPath, loadConfig, saveConfig } from "./config.ts";

Deno.test("save and load round-trips the repo path", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "nested", "config.toml");
  await saveConfig(path, { repo: "/home/user/gistan" });
  assertEquals(await loadConfig(path), { repo: "/home/user/gistan" });
});

Deno.test("load returns undefined when the file does not exist", async () => {
  const dir = await Deno.makeTempDir();
  assertEquals(await loadConfig(join(dir, "missing.toml")), undefined);
});

Deno.test("load rejects a config without a repo entry", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "config.toml");
  await Deno.writeTextFile(path, 'other = "value"\n');
  await assertRejects(() => loadConfig(path), Error, "repo");
});

Deno.test("defaultConfigPath prefers XDG_CONFIG_HOME over HOME", () => {
  assertEquals(
    defaultConfigPath({ HOME: "/home/u", XDG_CONFIG_HOME: "/xdg" }),
    "/xdg/gistan/config.toml",
  );
  assertEquals(defaultConfigPath({ HOME: "/home/u" }), "/home/u/.config/gistan/config.toml");
});
