"use client";

import { GitPanel } from "@/components/webcontainer/git-panel";
import { SaveProjectButton } from "@/components/webcontainer/save-project-button";
import { WebContainerEditor } from "@/components/webcontainer/webcontainer-editor";
import { WebContainerProvider } from "@/components/webcontainer/webcontainer-provider";

export function EditorWorkspace({
  projectId,
  projectName,
  githubToken,
  githubLogin,
}: {
  projectId: number;
  projectName: string;
  githubToken: string | null;
  githubLogin: string | null;
}) {
  return (
    <WebContainerProvider projectId={projectId}>
      <main className="p-6">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold">{projectName}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Files live in an in-browser WebContainer. Save a project to
              snapshot it; the snapshot and chat history are restored next time
              you open it.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <GitPanel
              projectId={projectId}
              githubToken={githubToken}
              githubLogin={githubLogin}
            />
            <SaveProjectButton projectId={projectId} />
          </div>
        </div>

        <div data-testid="editor-workspace" data-project-id={projectId}>
          <WebContainerEditor projectId={projectId} />
        </div>
      </main>
    </WebContainerProvider>
  );
}
