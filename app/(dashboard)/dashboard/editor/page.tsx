import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getLatestProjectForUser } from "@/lib/projects";

export const metadata = {
  title: "Editor",
};

/**
 * `/dashboard/editor` has no project of its own, so it forwards to the user's
 * most recent project. Use `/dashboard/editor/[projectId]` to pick one
 * explicitly.
 */
export default async function EditorIndexPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login");
  }

  const project = await getLatestProjectForUser(session.user.id);

  if (!project) {
    redirect("/dashboard");
  }

  redirect(`/dashboard/editor/${project.id}`);
}
