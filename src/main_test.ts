import { assertEquals } from "@std/assert";
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

Deno.test("returns usage on an unknown subcommand", async () => {
  const io = memoryContext();

  const code = await run(["unknown-cmd"], { context: io.context });

  assertEquals(code, 2);
  assertEquals(io.stdout, "");
  assertEquals(io.stderr.includes("Usage:"), true);
  assertEquals(io.stderr.includes("status"), true);
});
