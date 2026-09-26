import { inArray, sql } from "drizzle-orm";
import Link from "next/link";
import { auth } from "@/auth";
import { db } from "@/db/client";
import { fileSnapshots, messages } from "@/db/schema";
import { listProjectsForUser } from "@/lib/projects";
import { snapshotStorageKind } from "@/lib/storage";

export default async function DashboardPage() {
  const session = await auth();
  const userId = session?.user.id;

  if (!userId) {
    return (
      <main className="p-6">
        <h1 className="text-lg font-semibold">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">Not signed in.</p>
      </main>
    );
  }

  const userProjects = await listProjectsForUser(userId);
  const projectIds = userProjects.map((project) => project.id);

  const [messageCounts, snapshotCounts] =
    projectIds.length === 0
      ? [[], []]
      : await Promise.all([
          db
            .select({
              projectId: messages.projectId,
              count: sql<number>`count(*)::int`,
            })
            .from(messages)
            .where(inArray(messages.projectId, projectIds))
            .groupBy(messages.projectId),
          db
            .select({
              projectId: fileSnapshots.projectId,
              count: sql<number>`count(*)::int`,
            })
            .from(fileSnapshots)
            .where(inArray(fileSnapshots.projectId, projectIds))
            .groupBy(fileSnapshots.projectId),
        ]);

  const messagesByProject = new Map(
    messageCounts.map((row) => [row.projectId, row.count]),
  );
  const snapshotsByProject = new Map(
    snapshotCounts.map((row) => [row.projectId, row.count]),
  );

  const totalMessages = [...messagesByProject.values()].reduce(
    (sum, count) => sum + count,
    0,
  );
  const totalSnapshots = [...snapshotsByProject.values()].reduce(
    (sum, count) => sum + count,
    0,
  );

  return (
    <main className="p-6">
      <h1 className="text-lg font-semibold">Dashboard</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Signed in as {session.user.email}.
      </p>

      <ul className="mt-6 space-y-2 text-sm">
        {userProjects.length === 0 && <li>No projects yet.</li>}
        {userProjects.map((project) => (
          <li key={project.id}>
            <Link
              href={`/dashboard/editor/${project.id}`}
              className="font-medium underline"
            >
              {project.name}
            </Link>{" "}
            <span className="text-muted-foreground">
              · {messagesByProject.get(project.id) ?? 0} messages ·{" "}
              {snapshotsByProject.get(project.id) ?? 0} snapshots · opened{" "}
              {project.updatedAt.toISOString()}
            </span>
          </li>
        ))}
      </ul>

      <dl className="mt-6 flex flex-wrap gap-6 text-xs text-muted-foreground">
        <div>
          <dt className="inline">Projects: </dt>
          <dd className="inline">{userProjects.length}</dd>
        </div>
        <div>
          <dt className="inline">Messages: </dt>
          <dd className="inline">{totalMessages}</dd>
        </div>
        <div>
          <dt className="inline">Snapshots: </dt>
          <dd className="inline">{totalSnapshots}</dd>
        </div>
        <div>
          <dt className="inline">Storage backend: </dt>
          <dd className="inline">{snapshotStorageKind}</dd>
        </div>
      </dl>
    </main>
  );
}
