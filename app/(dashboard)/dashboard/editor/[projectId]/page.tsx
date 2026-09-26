import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { EditorWorkspace } from "@/components/webcontainer/editor-workspace";
import { getProjectForUser } from "@/lib/projects";

export const metadata = {
  title: "Editor",
};

type PageProps = {
  params: Promise<{ projectId: string }>;
};

export default async function ProjectEditorPage({ params }: PageProps) {
  const { projectId: raw } = await params;
  const session = await auth();

  if (!session?.user?.id) {
    notFound();
  }

  const projectId = Number(raw);

  if (!Number.isInteger(projectId) || projectId <= 0) {
    notFound();
  }

  const project = await getProjectForUser(projectId, session.user.id);

  if (!project) {
    notFound();
  }

  return (
    <EditorWorkspace
      projectId={project.id}
      projectName={project.name}
      githubToken={session.user.githubAccessToken ?? null}
      githubLogin={session.user.githubLogin ?? null}
    />
  );
}
