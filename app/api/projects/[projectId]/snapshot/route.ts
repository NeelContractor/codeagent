import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  getLatestSnapshot,
  getProjectForUser,
  recordSnapshot,
} from "@/lib/projects";
import { loadSnapshot, saveSnapshot, snapshotStorageKind } from "@/lib/storage";
import { countTarFileEntries } from "@/lib/tar";

export const runtime = "nodejs";
export const maxDuration = 60;

type RouteContext = { params: Promise<{ projectId: string }> };

const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

async function authorize(rawProjectId: string) {
  const session = await auth();

  if (!session?.user?.id) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const projectId = Number(rawProjectId);

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

  return { projectId };
}

/** Returns the stored snapshot tar, or 404 when the project has none. */
export async function GET(_request: Request, context: RouteContext) {
  const { projectId: raw } = await context.params;
  const auth = await authorize(raw);

  if (auth.error) {
    return auth.error;
  }

  const recorded = await getLatestSnapshot(auth.projectId);

  if (!recorded) {
    return NextResponse.json({ snapshot: null }, { status: 404 });
  }

  const buffer = await loadSnapshot(auth.projectId);

  if (!buffer) {
    return NextResponse.json(
      { error: "Snapshot record exists but its contents are missing." },
      { status: 410 },
    );
  }

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/x-tar",
      "Content-Length": String(buffer.byteLength),
      "Cache-Control": "no-store",
    },
  });
}

/** Stores the uploaded tar and records it in `file_snapshots`. */
export async function POST(request: Request, context: RouteContext) {
  const { projectId: raw } = await context.params;
  const auth = await authorize(raw);

  if (auth.error) {
    return auth.error;
  }

  const declared = Number(request.headers.get("content-length") ?? "0");

  if (Number.isFinite(declared) && declared > MAX_SNAPSHOT_BYTES) {
    return NextResponse.json(
      { error: "Snapshot is too large." },
      { status: 413 },
    );
  }

  const body = new Uint8Array(await request.arrayBuffer());

  if (body.byteLength === 0) {
    return NextResponse.json(
      { error: "Snapshot body was empty." },
      { status: 400 },
    );
  }

  if (body.byteLength > MAX_SNAPSHOT_BYTES) {
    return NextResponse.json(
      { error: "Snapshot is too large." },
      { status: 413 },
    );
  }

  let fileCount: number;

  try {
    fileCount = countTarFileEntries(body);
  } catch {
    return NextResponse.json(
      { error: "Uploaded snapshot is not a valid tar archive." },
      { status: 400 },
    );
  }

  const { storageKey, location } = await saveSnapshot(auth.projectId, body);

  await recordSnapshot({
    projectId: auth.projectId,
    storageKey,
    bytes: body.byteLength,
    fileCount,
  });

  return NextResponse.json(
    {
      storageKey,
      location,
      bytes: body.byteLength,
      fileCount,
      backend: snapshotStorageKind,
    },
    { status: 201 },
  );
}
