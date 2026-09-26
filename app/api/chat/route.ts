import Groq from "groq-sdk";
import type {
  ChatCompletionChunk,
  ChatCompletionMessage,
} from "groq-sdk/resources/chat/completions";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { CHAT_TOOLS } from "@/lib/chat-tools";

export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_MODEL = "llama-3.3-70b-versatile";
const MAX_MESSAGES = 60;
const MAX_CONTENT_LENGTH = 40000;
const MAX_TOOL_CALLS_PER_RESPONSE = 8;

type ApiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type ApiMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ApiToolCall[];
  tool_call_id?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseToolCalls(value: unknown): ApiToolCall[] | null {
  if (!Array.isArray(value) || value.length > MAX_TOOL_CALLS_PER_RESPONSE) {
    return null;
  }

  const calls: ApiToolCall[] = [];

  for (const entry of value) {
    if (!isRecord(entry) || !isRecord(entry.function)) {
      return null;
    }

    const { id, function: fn } = entry;
    const name = fn.name;
    const args = fn.arguments;

    if (typeof id !== "string" || id.length === 0) {
      return null;
    }

    if (typeof name !== "string" || name.length === 0) {
      return null;
    }

    if (args !== undefined && typeof args !== "string") {
      return null;
    }

    calls.push({
      id,
      type: "function",
      function: { name, arguments: args ?? "{}" },
    });
  }

  return calls;
}

function parseMessages(value: unknown): ApiMessage[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const window = value.slice(-MAX_MESSAGES);
  // Trimming from the front can orphan tool results whose assistant
  // tool_calls message was cut, so drop any leading `tool` messages.
  const firstIndex = window.findIndex(
    (entry) => isRecord(entry) && entry.role !== "tool",
  );
  const sliced = firstIndex === -1 ? window : window.slice(firstIndex);

  const parsed: ApiMessage[] = [];

  for (const entry of sliced) {
    if (!isRecord(entry)) {
      return null;
    }

    const { role, content, tool_calls, tool_call_id } = entry;

    if (
      role !== "system" &&
      role !== "user" &&
      role !== "assistant" &&
      role !== "tool"
    ) {
      return null;
    }

    if (
      content !== null &&
      content !== undefined &&
      typeof content !== "string"
    ) {
      return null;
    }

    const text =
      typeof content === "string" ? content.slice(0, MAX_CONTENT_LENGTH) : null;

    if (role === "assistant") {
      let calls: ApiToolCall[] | undefined;

      if (tool_calls !== undefined && tool_calls !== null) {
        const result = parseToolCalls(tool_calls);

        if (result === null) {
          return null;
        }

        calls = result;
      }

      if (!calls?.length && (text === null || text.length === 0)) {
        return null;
      }

      parsed.push(
        calls?.length
          ? { role, content: text, tool_calls: calls }
          : { role, content: text ?? "" },
      );
      continue;
    }

    if (role === "tool") {
      if (typeof tool_call_id !== "string" || tool_call_id.length === 0) {
        return null;
      }

      parsed.push({
        role,
        content: text ?? "",
        tool_call_id,
      });
      continue;
    }

    if (text === null || text.trim().length === 0) {
      return null;
    }

    parsed.push({ role, content: text });
  }

  return parsed;
}

type PendingToolCall = { id: string; name: string; args: string };

function toEventStream(
  upstream: AsyncIterable<ChatCompletionChunk>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const pending = new Map<number, PendingToolCall>();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      try {
        for await (const chunk of upstream) {
          const delta = chunk.choices?.[0]?.delta;

          if (delta?.content) {
            emit("delta", { text: delta.content });
          }

          for (const call of delta?.tool_calls ?? []) {
            const index = call.index ?? 0;
            const current = pending.get(index) ?? {
              id: "",
              name: "",
              args: "",
            };

            if (call.id) {
              current.id = call.id;
            }

            if (call.function?.name) {
              current.name = call.function.name;
            }

            if (call.function?.arguments) {
              current.args += call.function.arguments;
            }

            pending.set(index, current);
          }
        }

        const calls = [...pending.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, call]) => call)
          .filter((call) => call.name.length > 0)
          .slice(0, MAX_TOOL_CALLS_PER_RESPONSE);

        if (calls.length > 0) {
          emit("tool_calls", {
            calls: calls.map((call) => ({
              id: call.id,
              name: call.name,
              arguments: call.args,
            })),
          });
        }

        emit("done", {});
        controller.close();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Stream failed.";

        try {
          emit("error", { message });
          controller.close();
        } catch {
          controller.error(error);
        }
      }
    },
  });
}

export async function POST(request: Request) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.LLM_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: "LLM_API_KEY is not configured on the server." },
      { status: 500 },
    );
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const messages = parseMessages(
    (body as { messages?: unknown } | null)?.messages,
  );

  if (!messages) {
    return NextResponse.json(
      { error: "Expected a non-empty messages array of chat messages." },
      { status: 400 },
    );
  }

  const groq = new Groq({ apiKey, maxRetries: 1 });

  let upstream: AsyncIterable<ChatCompletionChunk>;

  try {
    upstream = await groq.chat.completions.create({
      model: process.env.LLM_MODEL ?? DEFAULT_MODEL,
      messages: messages as ChatCompletionMessage[],
      tools: CHAT_TOOLS,
      stream: true,
      temperature: 0.7,
      max_tokens: 2048,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Upstream request failed.";

    return NextResponse.json({ error: message }, { status: 502 });
  }

  return new Response(toEventStream(upstream), {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
