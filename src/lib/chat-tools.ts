import type { ChatCompletionTool } from "groq-sdk/resources/chat/completions";

export const TOOL_NAMES = [
  "read_file",
  "write_file",
  "list_dir",
  "run_command",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const MAX_TOOL_CALLS_PER_MESSAGE = 25;

export const CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a UTF-8 text file from the project and return its contents. Use this before editing a file you have not seen yet.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Path relative to the project root, for example 'src/index.js'.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or overwrite a UTF-8 text file. Missing parent directories are created automatically. Read a file first if you are modifying existing code.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Path relative to the project root, for example 'src/index.js'.",
          },
          contents: {
            type: "string",
            description: "The complete new contents of the file.",
          },
        },
        required: ["path", "contents"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description:
        "List the entries of a directory. Use '.' for the project root to discover what files exist.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Directory to list, relative to the project root. Defaults to '.'.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command in the project directory and return its combined stdout/stderr and exit code. Use for installing packages, running scripts, or inspecting the project. Prefer reading files over shelling out to 'cat'.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              "The shell command to execute, for example 'npm test'.",
          },
        },
        required: ["command"],
      },
    },
  },
];
