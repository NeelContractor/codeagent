import type { WebContainer } from "@webcontainer/api";
import { TOOL_NAMES, type ToolName } from "@/lib/chat-tools";

const MAX_OUTPUT_CHARS = 20000;
const COMMAND_TIMEOUT_MS = 30000;

export type ToolOutcome = { ok: boolean; output: string };

function truncate(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit)}\n… truncated ${text.length - limit} more characters`;
}

function resolvePath(input: unknown): string {
  const raw = typeof input === "string" ? input.trim() : "";
  const unquoted = raw.replace(/^["']|["']$/g, "");
  const segments: string[] = [];

  for (const part of unquoted.split("/")) {
    if (!part || part === ".") {
      continue;
    }

    if (part === "..") {
      segments.pop();
      continue;
    }

    segments.push(part);
  }

  return segments.join("/");
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : JSON.stringify(error);
}

async function readFile(wc: WebContainer, path: string): Promise<ToolOutcome> {
  try {
    const contents = await wc.fs.readFile(path || ".", "utf-8");
    const text = typeof contents === "string" ? contents : "";
    return {
      ok: true,
      output: truncate(text || "(file is empty)"),
    };
  } catch (error) {
    return { ok: false, output: `read_file failed: ${describe(error)}` };
  }
}

async function writeFile(
  wc: WebContainer,
  path: string,
  contents: string,
): Promise<ToolOutcome> {
  if (!path) {
    return { ok: false, output: "write_file failed: 'path' is required." };
  }

  if (typeof contents !== "string") {
    return { ok: false, output: "write_file failed: 'contents' is required." };
  }

  try {
    await wc.fs.writeFile(path, contents);
    return {
      ok: true,
      output: `Wrote ${contents.length} characters to ${path}.`,
    };
  } catch (error) {
    const parent = path.split("/").slice(0, -1).join("/");

    if (parent) {
      try {
        await wc.fs.mkdir(parent, { recursive: true });
        await wc.fs.writeFile(path, contents);
        return {
          ok: true,
          output: `Created ${parent}/ and wrote ${contents.length} characters to ${path}.`,
        };
      } catch (retryError) {
        return {
          ok: false,
          output: `write_file failed: ${describe(retryError)}`,
        };
      }
    }

    return { ok: false, output: `write_file failed: ${describe(error)}` };
  }
}

async function listDir(wc: WebContainer, path: string): Promise<ToolOutcome> {
  try {
    const entries = await wc.fs.readdir(path || ".", {
      withFileTypes: true,
      encoding: "utf-8",
    });

    if (entries.length === 0) {
      return { ok: true, output: "(empty directory)" };
    }

    const lines = entries
      .map((entry) => `${entry.isDirectory() ? "d" : "-"} ${entry.name}`)
      .sort((a, b) => a.localeCompare(b));

    return { ok: true, output: truncate(lines.join("\n")) };
  } catch (error) {
    return { ok: false, output: `list_dir failed: ${describe(error)}` };
  }
}

async function runCommand(
  wc: WebContainer,
  command: string,
): Promise<ToolOutcome> {
  if (typeof command !== "string" || command.trim().length === 0) {
    return { ok: false, output: "run_command failed: 'command' is required." };
  }

  let process: Awaited<ReturnType<WebContainer["spawn"]>>;

  try {
    process = await wc.spawn("jsh", ["-c", command]);
  } catch (error) {
    return {
      ok: false,
      output: `run_command failed to start: ${describe(error)}`,
    };
  }

  const writer = process.input.getWriter();

  try {
    await writer.close();
  } catch {
    // The shell may already have closed stdin; output is still readable.
  }

  const timeout = setTimeout(() => {
    process.kill();
  }, COMMAND_TIMEOUT_MS);

  let output = "";

  try {
    const reader = process.output.getReader();

    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      output += value;
    }

    const code = await process.exit;

    const body = output.trim();

    if (code === 0) {
      return { ok: true, output: truncate(body || "(no output, exit 0)") };
    }

    return { ok: false, output: truncate(`${body}\n(exit code ${code})`) };
  } catch (error) {
    return { ok: false, output: `run_command failed: ${describe(error)}` };
  } finally {
    clearTimeout(timeout);
  }
}

export async function executeToolCall(
  wc: WebContainer,
  name: string,
  args: unknown,
): Promise<ToolOutcome> {
  const params = (
    typeof args === "object" && args !== null ? args : {}
  ) as Record<string, unknown>;

  switch (name as ToolName) {
    case "read_file":
      return readFile(wc, resolvePath(params.path));
    case "write_file":
      return writeFile(wc, resolvePath(params.path), params.contents as string);
    case "list_dir":
      return listDir(wc, resolvePath(params.path ?? "."));
    case "run_command":
      return runCommand(wc, params.command as string);
    default:
      return {
        ok: false,
        output: `Unknown tool "${name}". Available tools: ${TOOL_NAMES.join(", ")}.`,
      };
  }
}
