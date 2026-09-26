import "server-only";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { fileSnapshots, messages, projects, type ToolCall } from "@/db/schema";

export const messageRoles = ["system", "user", "assistant", "tool"] as const;
export type MessageRole = (typeof messageRoles)[number];

/**
 * Roles the client is allowed to persist. `system` is deliberately excluded:
 * a caller-supplied system message would be replayed as trusted context on the
 * next turn, so the role stays server-owned.
 */
export const writableMessageRoles = ["user", "assistant", "tool"] as const;
export type WritableMessageRole = (typeof writableMessageRoles)[number];

/** The most recently touched project for a user, or `null` if they have none. */
export async function getLatestProjectForUser(userId: string) {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.userId, userId))
    .orderBy(desc(projects.updatedAt))
    .limit(1);

  return rows[0] ?? null;
}

export async function getProjectForUser(projectId: number, userId: string) {
  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);

  return rows[0] ?? null;
}

export async function listProjectsForUser(userId: string) {
  return db
    .select()
    .from(projects)
    .where(eq(projects.userId, userId))
    .orderBy(desc(projects.updatedAt));
}

export async function listMessages(projectId: number) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.projectId, projectId))
    .orderBy(asc(messages.id));
}

export async function insertMessage(input: {
  projectId: number;
  role: WritableMessageRole;
  content: string;
  toolCalls?: ToolCall[];
  /** Only meaningful for `role: "tool"`. */
  toolCallId?: string | null;
}) {
  const [row] = await db
    .insert(messages)
    .values({
      projectId: input.projectId,
      role: input.role,
      content: input.content,
      toolCalls: input.toolCalls ?? null,
      toolCallId: input.toolCallId ?? null,
    })
    .returning();

  // A new message means the project changed.
  await db
    .update(projects)
    .set({ updatedAt: new Date() })
    .where(eq(projects.id, input.projectId));

  return row;
}

export type LatestSnapshot = {
  id: number;
  storageKey: string;
  createdAt: Date;
};

export async function getLatestSnapshot(
  projectId: number,
): Promise<LatestSnapshot | null> {
  const rows = await db
    .select({
      id: fileSnapshots.id,
      storageKey: fileSnapshots.storageKey,
      createdAt: fileSnapshots.createdAt,
    })
    .from(fileSnapshots)
    .where(eq(fileSnapshots.projectId, projectId))
    .orderBy(desc(fileSnapshots.id))
    .limit(1);

  return rows[0] ?? null;
}

export async function recordSnapshot(input: {
  projectId: number;
  storageKey: string;
  bytes: number;
  fileCount: number;
}) {
  // A project's snapshot key is derived from its id, so saving again overwrites
  // the same object. Upserting keeps `storage_key` unique while still recording
  // the latest size, file count, and save time.
  const [row] = await db
    .insert(fileSnapshots)
    .values({
      projectId: input.projectId,
      storageKey: input.storageKey,
      bytes: input.bytes,
      fileCount: input.fileCount,
    })
    .onConflictDoUpdate({
      target: fileSnapshots.storageKey,
      set: {
        projectId: input.projectId,
        bytes: input.bytes,
        fileCount: input.fileCount,
        createdAt: new Date(),
      },
    })
    .returning();

  await db
    .update(projects)
    .set({ updatedAt: new Date() })
    .where(eq(projects.id, input.projectId));

  return row;
}
