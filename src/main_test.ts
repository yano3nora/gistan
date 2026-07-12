import { assert, assertEquals } from "@std/assert";
import { COMMAND_DESCRIPTIONS, run, usage } from "./main.ts";
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

Deno.test("an unrecognized first argument falls back to search (full sugar, TASK-260708)", async () => {
  const io = memoryContext();
  let received: CommandArgs | undefined;

  const code = await run(["unknown-cmd"], {
    context: io.context,
    commands: {
      search(command) {
        received = command;
        return 0;
      },
    },
  });

  assertEquals(code, 0);
  assertEquals(received, { name: "search", args: ["unknown-cmd"] });
  assertEquals(io.stderr, "");
});

Deno.test("a leading flag reaches search untouched, e.g. `gistan -p foo` (TASK-260708)", async () => {
  const io = memoryContext();
  let received: CommandArgs | undefined;

  const code = await run(["-p", "foo"], {
    context: io.context,
    commands: {
      search(command) {
        received = command;
        return 0;
      },
    },
  });

  assertEquals(code, 0);
  assertEquals(received, { name: "search", args: ["-p", "foo"] });
});

Deno.test("`gistan s` is no longer an alias — it falls through to search as a query", async () => {
  const io = memoryContext();
  let received: CommandArgs | undefined;

  const code = await run(["s", "foo"], {
    context: io.context,
    commands: {
      search(command) {
        received = command;
        return 0;
      },
    },
  });

  assertEquals(code, 0);
  assertEquals(received, { name: "search", args: ["s", "foo"] });
});

Deno.test("`gistan grep` dispatches to the grep command (TASK-260708 followup 2)", async () => {
  const io = memoryContext();
  let received: CommandArgs | undefined;

  const code = await run(["grep", "-p", "foo"], {
    context: io.context,
    commands: {
      grep(command) {
        received = command;
        return 0;
      },
    },
  });

  assertEquals(code, 0);
  assertEquals(received, { name: "grep", args: ["-p", "foo"] });
});

Deno.test("-h/--help prints usage, mentioning grep, root status, and the s alias", async () => {
  const io = memoryContext();

  const code = await run(["-h"], { context: io.context });

  assertEquals(code, 0);
  assertEquals(io.stderr, "");
  assert(io.stdout.includes("Usage:"));
  assert(io.stdout.includes("gistan s"));
  assert(io.stdout.includes("status"));
  assert(io.stdout.includes("grep"));
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

Deno.test("root's description mentions status (TASK-260708)", () => {
  assert(COMMAND_DESCRIPTIONS.root.includes("status"));
});

Deno.test("__search-render dispatches to the hidden renderer, not the search fallback", async () => {
  const io = memoryContext();
  let searchCalled = false;

  // The default runner answers every rg call with empty output, so the
  // renderer prints nothing and exits 0; falling back to search would
  // instead fail on the missing config (exit 1 + stderr).
  const code = await run(["__search-render", "foo"], {
    context: io.context,
    commands: {
      search() {
        searchCalled = true;
        return 1;
      },
    },
  });

  assertEquals(code, 0);
  assertEquals(searchCalled, false);
  assertEquals(io.stderr, "");
});

Deno.test("__search-render is not advertised in usage()", () => {
  assertEquals(usage().includes("__search-render"), false);
});

Deno.test("__preview dispatches to the hidden preview renderer, not the search fallback", async () => {
  const io = memoryContext();
  let searchCalled = false;

  // An empty {1} makes the renderer a silent no-op (exit 0); the search
  // fallback would instead fail on the missing config (exit 1 + stderr).
  const code = await run(["__preview", "search", "nobat", "query", ""], {
    context: io.context,
    commands: {
      search() {
        searchCalled = true;
        return 1;
      },
    },
  });

  assertEquals(code, 0);
  assertEquals(searchCalled, false);
  assertEquals(io.stderr, "");
});

Deno.test("__preview is not advertised in usage()", () => {
  assertEquals(usage().includes("__preview"), false);
});

Deno.test("__grep-render dispatches to the hidden renderer, not the search fallback", async () => {
  const io = memoryContext();
  let searchCalled = false;

  // The default runner answers every rg call with empty output, so the
  // renderer prints nothing and exits 0; falling back to search would
  // instead fail on the missing config (exit 1 + stderr).
  const code = await run(["__grep-render", "foo"], {
    context: io.context,
    commands: {
      search() {
        searchCalled = true;
        return 1;
      },
    },
  });

  assertEquals(code, 0);
  assertEquals(searchCalled, false);
  assertEquals(io.stderr, "");
});

Deno.test("__grep-render is not advertised in usage()", () => {
  assertEquals(usage().includes("__grep-render"), false);
});

Deno.test("__list dispatches to the hidden list renderer, not the search fallback", async () => {
  const io = memoryContext();
  let searchCalled = false;

  const code = await run(["__list"], {
    context: io.context,
    commands: {
      search() {
        searchCalled = true;
        return 1;
      },
    },
  });

  assertEquals(code, 0);
  assertEquals(searchCalled, false);
  assertEquals(io.stderr, "");
});

Deno.test("__list is not advertised in usage()", () => {
  assertEquals(usage().includes("__list"), false);
});

Deno.test("__open dispatches to the hidden open action, not the search fallback", async () => {
  const io = memoryContext();
  let searchCalled = false;

  // An empty {1} makes the action a silent no-op (exit 0); the search
  // fallback would instead fail on the missing config (exit 1 + stderr).
  const code = await run(["__open", ""], {
    context: io.context,
    commands: {
      search() {
        searchCalled = true;
        return 1;
      },
    },
  });

  assertEquals(code, 0);
  assertEquals(searchCalled, false);
  assertEquals(io.stderr, "");
});

Deno.test("__open is not advertised in usage()", () => {
  assertEquals(usage().includes("__open"), false);
});

Deno.test("__copy dispatches to the hidden copy action, not the search fallback", async () => {
  const io = memoryContext();
  let searchCalled = false;

  const code = await run(["__copy", ""], {
    context: io.context,
    commands: {
      search() {
        searchCalled = true;
        return 1;
      },
    },
  });

  assertEquals(code, 0);
  assertEquals(searchCalled, false);
  assertEquals(io.stderr, "");
});

Deno.test("__copy is not advertised in usage()", () => {
  assertEquals(usage().includes("__copy"), false);
});

Deno.test("dispatches the push command (ADR-0003: local-drift bulk publish)", async () => {
  const io = memoryContext();
  let received: CommandArgs | undefined;

  const code = await run(["push"], {
    context: io.context,
    commands: {
      push(command) {
        received = command;
        return 0;
      },
    },
  });

  assertEquals(code, 0);
  assertEquals(received, { name: "push", args: [] });
});

Deno.test("a command that throws exits 1 with one error line, not a stack trace", async () => {
  const io = memoryContext();
  const code = await run(["list"], {
    context: io.context,
    commands: {
      list: () => {
        throw new Error("boom");
      },
    },
  });
  assertEquals(code, 1);
  assertEquals(io.stderr, "error: boom\n");
});
