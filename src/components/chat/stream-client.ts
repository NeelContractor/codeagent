export type StreamedToolCall = { id: string; name: string; arguments: string };

export type AssistantTurn = {
  text: string;
  toolCalls: StreamedToolCall[];
};

type SseEvent = { event: string; data: string };

async function* readEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");

    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      let event = "message";
      const dataLines: string[] = [];

      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        }
      }

      if (dataLines.length > 0) {
        yield { event, data: dataLines.join("\n") };
      }

      boundary = buffer.indexOf("\n\n");
    }
  }
}

export async function streamAssistantTurn(
  messages: unknown[],
  signal: AbortSignal,
  onText: (chunk: string, accumulated: string) => void,
): Promise<AssistantTurn> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
    signal,
  });

  if (!response.ok || !response.body) {
    const detail = await response
      .json()
      .then((data: { error?: string }) => data.error)
      .catch(() => null);

    throw new Error(detail ?? `Request failed (${response.status}).`);
  }

  const contentType = response.headers.get("Content-Type") ?? "";

  if (!contentType.includes("text/event-stream")) {
    throw new Error("Unexpected response format from /api/chat.");
  }

  let text = "";
  let toolCalls: StreamedToolCall[] = [];

  for await (const { event, data } of readEvents(response.body)) {
    if (event === "delta") {
      const payload = JSON.parse(data) as { text?: string };

      if (payload.text) {
        text += payload.text;
        onText(payload.text, text);
      }
      continue;
    }

    if (event === "tool_calls") {
      const payload = JSON.parse(data) as { calls?: StreamedToolCall[] };

      if (Array.isArray(payload.calls)) {
        toolCalls = payload.calls;
      }
      continue;
    }

    if (event === "error") {
      const payload = JSON.parse(data) as { message?: string };
      throw new Error(payload.message ?? "The model stream failed.");
    }

    if (event === "done") {
      break;
    }
  }

  return { text, toolCalls };
}
