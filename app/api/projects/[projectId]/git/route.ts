import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  clearGitConnection,
  getGitConnection,
  saveGitConnection,
} from "@/lib/github";
import { getProjectForUser } from "@/lib/projects";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ projectId: string }> };

async function authorize(raw: string) {
  const session = await auth();

  if (!session?.user?.id) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const projectId = Number(raw);
  if (!Number.isInteger(projectId) || projectId <= 0) {
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

  return { projectId, userId: session.user.id };
}

/** The repository this project is bound to, if any. */
export async function GET(_request: Request, context: RouteContext) {
  const { projectId: raw } = await context.params;
  const authResult = await authorize(raw);

  if (authResult.error) {
    return authResult.error;
  }

  const connection = await getGitConnection(authResult.projectId);

  return NextResponse.json(
    { connection },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** Binds the project to a repository and branch. */
export async function PUT(request: Request, context: RouteContext) {
  const { projectId: raw } = await context.params;
  const authResult = await authorize(raw);

  if (authResult.error) {
    return authResult.error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { repo, branch } = (body ?? {}) as { repo?: unknown; branch?: unknown };

  if (typeof repo !== "string" || typeof branch !== "string") {
    return NextResponse.json(
      { error: "repo and branch must be strings." },
      { status: 400 },
    );
  }

  try {
    const connection = await saveGitConnection({
      projectId: authResult.projectId,
      repo,
      branch,
    });
    return NextResponse.json({ connection });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not save the connection.",
      },
      { status: 400 },
    );
  }
}

/** Unbinds the project from its repository. */
export async function DELETE(_request: Request, context: RouteContext) {
  const { projectId: raw } = await context.params;
  const authResult = await authorize(raw);

  if (authResult.error) {
    return authResult.error;
  }

  await clearGitConnection(authResult.projectId);
  return NextResponse.json({ ok: true });
}
