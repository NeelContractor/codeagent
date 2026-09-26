import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { listGitHubRepos } from "@/lib/github";

export const runtime = "nodejs";

/**
 * Repositories reachable with the signed-in user's GitHub token. The token is
 * only read here, on the server; the browser already has its own copy for the
 * in-container git operations.
 */
export async function GET() {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = session.user.githubAccessToken;

  if (!token) {
    return NextResponse.json(
      { error: "GitHub is not connected for this account." },
      { status: 409 },
    );
  }

  try {
    const repos = await listGitHubRepos(token);
    return NextResponse.json(
      { repos },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not load repositories from GitHub.",
      },
      { status: 502 },
    );
  }
}
