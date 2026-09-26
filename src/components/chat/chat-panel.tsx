"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWebContainer } from "@/components/webcontainer/webcontainer-provider";
import { MAX_TOOL_CALLS_PER_MESSAGE, TOOL_NAMES } from "@/lib/chat-tools";
import { streamAssistantTurn } from "./stream-client";
import { ToolCallCard } from "./tool-call-card";
import { executeToolCall } from "./tool-runner";

type ToolCall = { id: string; name: string; args: string };

type UiMessage =
  | { id: string; kind: "user"; content: string }
  | { id: string; kind: "assistant"; content: string; toolCalls: ToolCall[] }
  | {
      id: string;
      kind: "tool";
      callId: string;
      name: string;
      args: string;
      result: string;
      ok: boolean;
      status: "running" | "done";
    }
  | { id: string; kind: "notice"; content: string };

const MAX_HISTORY_MESSAGES = 40;

let idCounter = 0;
const nextId = () => `m${++idCounter}`;

function isKnownTool(name: string): boolean {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

function safeParse(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }

    return null;
  } catch {
    return null;
  }
}

function buildApiHistory(messages: UiMessage[]): unknown[] {
  const history: Record<string, unknown>[] = [];

  for (const message of messages) {
    if (message.kind === "user") {
      history.push({ role: "user", content: message.content });
      continue;
    }

    if (message.kind === "assistant") {
      if (message.toolCalls.length > 0) {
        history.push({
          role: "assistant",
          content: message.content || null,
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.args },
          })),
        });
      } else if (message.content.length > 0) {
        history.push({ role: "assistant", content: message.content });
      }

      // An assistant message with neither text nor tool calls is the
      // in-flight placeholder for a turn that has not streamed yet.
      continue;
    }

    if (message.kind === "tool") {
      history.push({
        role: "tool",
        tool_call_id: message.callId,
        content: message.result,
      });
    }
  }

  if (history.length <= MAX_HISTORY_MESSAGES) {
    return history;
  }

  // Trim from the front, but only cut on a user boundary so every
  // assistant tool_calls message keeps its matching tool results.
  const kept: Record<string, unknown>[] = [];

  for (let index = history.length - 1; index >= 0; index -= 1) {
    kept.unshift(history[index]);

    if (history[index].role === "user" && kept.length >= MAX_HISTORY_MESSAGES) {
      break;
    }
  }

  const firstUser = kept.findIndex((message) => message.role === "user");

  return firstUser === -1 ? kept : kept.slice(firstUser);
}

export function ChatPanel({ projectId }: { projectId?: number }) {
  const { wc, status } = useWebContainer();
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyState, setHistoryState] = useState<
    "idle" | "loading" | "ready"
  >("idle");
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<UiMessage[]>([]);
  const hydratedRef = useRef<number | null>(null);

  const commit = useCallback((updater: (prev: UiMessage[]) => UiMessage[]) => {
    const next = updater(messagesRef.current);
    messagesRef.current = next;
    setMessages(next);
  }, []);

  /**
   * Persist a single message. Failures are surfaced but never block the
   * conversation, because a dropped history row should not lose the reply the
   * user is looking at.
   */
  const persist = useCallback(
    async (input2: {
      role: "user" | "assistant" | "tool";
      content: string;
      toolCalls?: { id: string; name: string; arguments: unknown }[];
      toolCallId?: string;
    }) => {
      if (projectId === undefined) {
        return;
      }

      try {
        const response = await fetch(`/api/projects/${projectId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            role: input2.role,
            content: input2.content,
            toolCalls: input2.toolCalls,
            toolCallId: input2.toolCallId,
          }),
        });

        if (!response.ok) {
          const detail = await response
            .json()
            .then((data: { error?: string }) => data.error)
            .catch(() => null);

          setError(`Could not save message: ${detail ?? response.status}`);
        }
      } catch {
        setError("Could not save message to the database.");
      }
    },
    [projectId],
  );

  // Resume chat history from Postgres once per project.
  useEffect(() => {
    if (projectId === undefined || hydratedRef.current === projectId) {
      return;
    }

    setHistoryState("loading");

    // StrictMode runs effects twice. The project is only marked hydrated after a
    // successful load, so the discarded first attempt cannot block the retry.
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(`/api/projects/${projectId}/messages`, {
          cache: "no-store",
        });

        if (cancelled) {
          return;
        }

        if (!response.ok) {
          setHistoryState("ready");
          return;
        }

        const data = (await response.json()) as {
          messages: {
            id: number;
            role: string;
            content: string;
            toolCalls:
              | { id: string; name: string; arguments: unknown }[]
              | null;
            toolCallId: string | null;
          }[];
        };

        const restored: UiMessage[] = [];
        // Tool result rows only store the call id, so remember each call's name
        // and arguments from the assistant message that requested it.
        const callMeta = new Map<string, { name: string; args: string }>();

        for (const row of data.messages) {
          if (row.role === "user") {
            restored.push({
              id: `db-${row.id}`,
              kind: "user",
              content: row.content,
            });
          } else if (row.role === "assistant") {
            const toolCalls = (row.toolCalls ?? []).map((call) => ({
              id: call.id,
              name: call.name,
              args: JSON.stringify(call.arguments),
            }));

            for (const call of toolCalls) {
              callMeta.set(call.id, { name: call.name, args: call.args });
            }

            restored.push({
              id: `db-${row.id}`,
              kind: "assistant",
              content: row.content,
              toolCalls,
            });
          } else if (row.role === "tool") {
            const callId = row.toolCallId ?? `db-${row.id}`;
            const meta = callMeta.get(callId);

            restored.push({
              id: `db-${row.id}`,
              kind: "tool",
              callId,
              name: meta?.name ?? "tool",
              args: meta?.args ?? "",
              result: row.content,
              // Success is not persisted, so do not claim it either way.
              ok: true,
              status: "done",
            });
          }
        }

        if (cancelled) {
          return;
        }

        messagesRef.current = restored;
        setMessages(restored);
        hydratedRef.current = projectId;
      } catch {
        // Leave the transcript empty; the user can still chat.
      } finally {
        if (!cancelled) {
          setHistoryState("ready");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const lastMessage = messages.at(-1);

  useEffect(() => {
    if (!lastMessage) {
      return;
    }

    const node = scrollRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [lastMessage]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const workspaceReady = status === "ready" && wc !== null;

  const send = useCallback(async () => {
    const content = input.trim();

    if (!content || isStreaming || !wc) {
      return;
    }

    commit((prev) => [...prev, { id: nextId(), kind: "user", content }]);
    setInput("");
    setError(null);
    setIsStreaming(true);
    void persist({ role: "user", content });

    const controller = new AbortController();
    abortRef.current = controller;

    let toolCallCount = 0;

    const addToolMessage = (
      call: ToolCall,
      result: string,
      ok: boolean,
      statusValue: "running" | "done",
    ) => {
      commit((prev) => [
        ...prev,
        {
          id: nextId(),
          kind: "tool",
          callId: call.id,
          name: call.name,
          args: call.args,
          result,
          ok,
          status: statusValue,
        },
      ]);

      void persist({ role: "tool", content: result, toolCallId: call.id });
    };

    try {
      for (;;) {
        const assistantId = nextId();

        commit((prev) => [
          ...prev,
          { id: assistantId, kind: "assistant", content: "", toolCalls: [] },
        ]);

        const turn = await streamAssistantTurn(
          buildApiHistory(messagesRef.current),
          controller.signal,
          (_chunk, accumulated) => {
            commit((prev) =>
              prev.map((message) =>
                message.id === assistantId && message.kind === "assistant"
                  ? { ...message, content: accumulated }
                  : message,
              ),
            );
          },
        );

        if (turn.toolCalls.length === 0) {
          const finished = messagesRef.current.find(
            (message) => message.id === assistantId,
          );

          if (finished?.kind === "assistant" && finished.content.length === 0) {
            commit((prev) =>
              prev.filter((message) => message.id !== assistantId),
            );
          } else if (finished?.kind === "assistant") {
            void persist({ role: "assistant", content: finished.content });
          }

          break;
        }

        const calls: ToolCall[] = turn.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          args: call.arguments,
        }));

        commit((prev) =>
          prev.map((message) =>
            message.id === assistantId && message.kind === "assistant"
              ? { ...message, toolCalls: calls }
              : message,
          ),
        );

        void persist({
          role: "assistant",
          content: turn.text,
          toolCalls: calls.map((call) => ({
            id: call.id,
            name: call.name,
            arguments: safeParse(call.args) ?? {},
          })),
        });

        const remainingBudget = MAX_TOOL_CALLS_PER_MESSAGE - toolCallCount;
        const executable = calls.slice(0, Math.max(0, remainingBudget));
        const skipped = calls.slice(executable.length);

        for (const call of executable) {
          toolCallCount += 1;

          const toolId = nextId();
          const parsed = safeParse(call.args);

          if (!isKnownTool(call.name)) {
            addToolMessage(
              call,
              `Unknown tool "${call.name}". Available tools: ${TOOL_NAMES.join(", ")}.`,
              false,
              "done",
            );
            continue;
          }

          if (parsed === null) {
            addToolMessage(
              call,
              `Arguments were not a JSON object, so the call was not run. Raw: ${call.args}`,
              false,
              "done",
            );
            continue;
          }

          commit((prev) => [
            ...prev,
            {
              id: toolId,
              kind: "tool",
              callId: call.id,
              name: call.name,
              args: call.args,
              result: "",
              ok: false,
              status: "running",
            },
          ]);

          const outcome = await executeToolCall(wc, call.name, parsed);

          commit((prev) =>
            prev.map((message) =>
              message.id === toolId && message.kind === "tool"
                ? {
                    ...message,
                    result: outcome.output,
                    ok: outcome.ok,
                    status: "done",
                  }
                : message,
            ),
          );

          void persist({
            role: "tool",
            content: outcome.output,
            toolCallId: call.id,
          });
        }

        for (const call of skipped) {
          addToolMessage(
            call,
            `Skipped: reached the limit of ${MAX_TOOL_CALLS_PER_MESSAGE} tool calls for one message.`,
            false,
            "done",
          );
        }

        if (skipped.length > 0) {
          commit((prev) => [
            ...prev,
            {
              id: nextId(),
              kind: "notice",
              content: `Stopped after ${MAX_TOOL_CALLS_PER_MESSAGE} tool calls for this message — that is the limit per request. Send a new message to start a fresh budget.`,
            },
          ]);
          break;
        }
      }
    } catch (streamError) {
      if (controller.signal.aborted) {
        commit((prev) => [
          ...prev,
          { id: nextId(), kind: "notice", content: "_Response stopped._" },
        ]);
      } else {
        setError(
          streamError instanceof Error
            ? streamError.message
            : "Something went wrong.",
        );
      }
    } finally {
      abortRef.current = null;
      setIsStreaming(false);
    }
  }, [commit, input, isStreaming, persist, wc]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const rendered = useMemo(
    () =>
      messages.map((message) => {
        if (message.kind === "user") {
          return (
            <div
              key={message.id}
              data-role="user"
              className="ml-6 rounded-md bg-primary px-3 py-2 whitespace-pre-wrap text-primary-foreground"
            >
              {message.content}
            </div>
          );
        }

        if (message.kind === "notice") {
          return (
            <div
              key={message.id}
              data-role="notice"
              data-testid="chat-notice"
              className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
            >
              {message.content}
            </div>
          );
        }

        if (message.kind === "tool") {
          return (
            <div key={message.id} className="mr-6">
              <ToolCallCard
                name={message.name}
                args={message.args}
                result={message.result}
                ok={message.ok}
                status={message.status}
              />
            </div>
          );
        }

        if (message.content.length === 0) {
          return null;
        }

        return (
          <div
            key={message.id}
            data-role="assistant"
            data-testid="chat-assistant"
            className="mr-6 rounded-md bg-muted px-3 py-2 whitespace-pre-wrap"
          >
            {message.content}
          </div>
        );
      }),
    [messages],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b px-3 py-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Chat
        {historyState === "loading" && (
          <span
            data-testid="chat-history-state"
            className="ml-2 font-normal normal-case"
          >
            loading history…
          </span>
        )}
        {historyState === "ready" && (
          <span
            data-testid="chat-history-state"
            data-state="ready"
            className="ml-2 font-normal normal-case"
          >
            {messages.length} message{messages.length === 1 ? "" : "s"}
          </span>
        )}
        {!workspaceReady && (
          <span className="ml-2 font-normal normal-case">
            workspace {status}…
          </span>
        )}
      </div>

      <div
        ref={scrollRef}
        data-testid="chat-messages"
        className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-sm"
      >
        {messages.length === 0 && (
          <p className="text-muted-foreground">
            Ask something to start the conversation.
          </p>
        )}
        {rendered}
      </div>

      {error && (
        <p
          data-testid="chat-error"
          className="shrink-0 border-t border-destructive/40 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      )}

      <form
        className="flex shrink-0 items-end gap-2 border-t p-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          data-testid="chat-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder="Send a message…"
          className="min-h-[2.5rem] flex-1 resize-none rounded-md border px-2 py-1.5 text-sm"
        />
        {isStreaming ? (
          <button
            type="button"
            data-testid="chat-stop"
            onClick={stop}
            className="rounded-md border px-3 py-2 text-sm hover:bg-accent"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            data-testid="chat-send"
            disabled={input.trim().length === 0 || !workspaceReady}
            className="rounded-md border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50"
          >
            Send
          </button>
        )}
      </form>
    </div>
  );
}
