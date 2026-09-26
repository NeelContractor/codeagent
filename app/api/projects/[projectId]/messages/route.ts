import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  getLatestSnapshot,
  getProjectForUser,
  insertMessage,
  listMessages,
  type WritableMessageRole,
  writableMessageRoles,
} from "@/lib/projects";

type RouteContext = { params: Promise<{ projectId: string }> };

function parseProjectId(raw: string): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** Resolves the signed-in user's project, or writes the failure itself. */
async function authorize(rawProjectId: string) {
  const session = await auth();

  if (!session?.user?.id) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const projectId = parseProjectId(rawProjectId);

  if (projectId === null) {
    return {
      error: NextResponse.json(
        { error: "Invalid project id." },
        { status: 400 },
      ),
    };
  }

  const project = await getProjectForUser(projectId, session.user.id);

  if (!project) {
    return {
      error: NextResponse.json(
        { error: "Project not found." },
        { status: 404 },
      ),
    };
  }

  return { project, projectId };
}

export async function GET(_request: Request, context: RouteContext) {
  const { projectId: raw } = await context.params;
  const auth = await authorize(raw);

  if (auth.error) {
    return auth.error;
  }

  const [rows, snapshot] = await Promise.all([
    listMessages(auth.projectId),
    getLatestSnapshot(auth.projectId),
  ]);

  return NextResponse.json({
    messages: rows.map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      toolCalls: row.toolCalls ?? null,
      toolCallId: row.toolCallId ?? null,
      createdAt: row.createdAt,
    })),
    snapshot: snapshot
      ? {
          storageKey: snapshot.storageKey,
          createdAt: snapshot.createdAt,
        }
      : null,
  });
}

const MAX_CONTENT_LENGTH = 40000;
const MAX_TOOL_CALLS = 16;

export async function POST(request: Request, context: RouteContext) {
  const { projectId: raw } = await context.params;
  const auth = await authorize(raw);

  if (auth.error) {
    return auth.error;
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { role, content, toolCalls, toolCallId } = (body ?? {}) as {
    role?: unknown;
    content?: unknown;
    toolCalls?: unknown;
    toolCallId?: unknown;
  };

  if (
    typeof role !== "string" ||
    !(writableMessageRoles as readonly string[]).includes(role)
  ) {
    return NextResponse.json({ error: "Invalid role." }, { status: 400 });
  }

  if (typeof content !== "string") {
    return NextResponse.json(
      { error: "content must be a string." },
      { status: 400 },
    );
  }

  if (content.length > MAX_CONTENT_LENGTH) {
    return NextResponse.json(
      { error: `content exceeds ${MAX_CONTENT_LENGTH} characters.` },
      { status: 413 },
    );
  }

  if (
    toolCallId !== undefined &&
    toolCallId !== null &&
    typeof toolCallId !== "string"
  ) {
    return NextResponse.json(
      { error: "toolCallId must be a string." },
      { status: 400 },
    );
  }

  let normalizedToolCalls:
    | { id: string; name: string; arguments: Record<string, unknown> }[]
    | null = null;

  if (toolCalls !== undefined && toolCalls !== null) {
    if (
      !Array.isArray(toolCalls) ||
      toolCalls.length > MAX_TOOL_CALLS ||
      !toolCalls.every(
        (call) =>
          typeof call === "object" &&
          call !== null &&
          typeof (call as { id?: unknown }).id === "string" &&
          typeof (call as { name?: unknown }).name === "string" &&
          typeof (call as { arguments?: unknown }).arguments === "object" &&
          (call as { arguments?: unknown }).arguments !== null,
      )
    ) {
      return NextResponse.json(
        { error: "toolCalls must be an array of { id, name, arguments }." },
        { status: 400 },
      );
    }

    normalizedToolCalls = toolCalls as {
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }[];
  }

  const row = await insertMessage({
    projectId: auth.projectId,
    role: role as WritableMessageRole,
    content,
    toolCalls: normalizedToolCalls ?? undefined,
    toolCallId: typeof toolCallId === "string" ? toolCallId : null,
  });

  return NextResponse.json(
    {
      message: {
        id: row.id,
        role: row.role,
        content: row.content,
        toolCalls: row.toolCalls ?? null,
        toolCallId: row.toolCallId ?? null,
        createdAt: row.createdAt,
      },
    },
    { status: 201 },
  );
}
