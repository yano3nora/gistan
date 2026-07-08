import { assert, assertEquals } from "@std/assert";
import { run } from "./main.ts";
import type { CommandArgs, CommandContext } from "./commands/types.ts";

function memoryContext() {
  let stdout = "";
  let stderr = "";
  const encoder = new TextDecoder();
  const context: CommandContext = {
    stdout: {
      write(chunk: Uint8Array): Promise<number> {
        stdout += encoder.decode(chunk, { stream: true });
        return Promise.resolve(chunk.byteLength);
      },
    },
    stderr: {
      write(chunk: Uint8Array): Promise<number> {
        stderr += encoder.decode(chunk, { stream: true });
        return Promise.resolve(chunk.byteLength);
      },
    },
    runner: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
    configPath: "/nonexistent/gistan-test/config.toml",
    home: "/nonexistent/gistan-test",
    confirm: () => Promise.resolve(true),
    editor: "vi",
  };

  return {
    context,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

Deno.test("dispatches a known subcommand without spawning a subprocess", async () => {
  const io = memoryContext();
  let received: CommandArgs | undefined;

  const code = await run(["status", "snippets/example.md"], {
    context: io.context,
    commands: {
      status(command) {
        received = command;
        return 0;
      },
    },
  });

  assertEquals(code, 0);
  assertEquals(received, { name: "status", args: ["snippets/example.md"] });
  assertEquals(io.stderr, "");
});

Deno.test("bare invocation drops into search", async () => {
  const io = memoryContext();
  let received: CommandArgs | undefined;

  const code = await run([], {
    context: io.context,
    commands: {
      search(command) {
        received = command;
        return 0;
      },
    },
  });

  assertEquals(code, 0);
  assertEquals(received, { name: "search", args: [] });
});

Deno.test("returns usage on an unknown subcommand", async () => {
  const io = memoryContext();

  const code = await run(["unknown-cmd"], { context: io.context });

  assertEquals(code, 2);
  assertEquals(io.stdout, "");
  assertEquals(io.stderr.includes("Usage:"), true);
  assertEquals(io.stderr.includes("status"), true);
});

Deno.test("prints version without dispatching a command", async () => {
  const io = memoryContext();
  const code = await run(["--version"], { context: io.context });
  assertEquals(code, 0);
  assertEquals(io.stdout.trim().startsWith("gistan "), true);
  assertEquals(io.stderr, "");
});

Deno.test("gistan init points the user at gistan root init (TASK-260708)", async () => {
  const io = memoryContext();
  const code = await run(["init", "some-dir"], { context: io.context });
  assertEquals(code, 2);
  assert(io.stderr.includes("did you mean 'gistan root init'?"));
});

Deno.test("gistan sync points the user at gistan root commit/push/pull (TASK-260708)", async () => {
  const io = memoryContext();
  const code = await run(["sync"], { context: io.context });
  assertEquals(code, 2);
  assert(io.stderr.includes("'gistan sync' was removed — use 'gistan root commit / push / pull'"));
});
