"use client";

import { useCallback, useState } from "react";
import { tarWebContainer } from "./snapshot";
import { useWebContainer } from "./webcontainer-provider";

type SaveState =
  | { phase: "idle" }
  | { phase: "saving"; files: number }
  | {
      phase: "saved";
      bytes: number;
      files: number;
      location: string;
    }
  | { phase: "error"; message: string };

export function SaveProjectButton({ projectId }: { projectId?: number }) {
  const { wc, status } = useWebContainer();
  const [state, setState] = useState<SaveState>({ phase: "idle" });

  const save = useCallback(async () => {
    if (!wc || projectId === undefined) {
      setState({
        phase: "error",
        message:
          projectId === undefined
            ? "Open a project before saving a snapshot."
            : "The workspace is still starting.",
      });
      return;
    }

    setState({ phase: "saving", files: 0 });

    try {
      const snapshot = await tarWebContainer(wc, (files) =>
        setState({ phase: "saving", files }),
      );

      const response = await fetch(`/api/projects/${projectId}/snapshot`, {
        method: "POST",
        headers: { "Content-Type": "application/x-tar" },
        body: snapshot.tar as unknown as BodyInit,
      });

      if (!response.ok) {
        const detail = await response
          .json()
          .then((data: { error?: string }) => data.error)
          .catch(() => null);

        throw new Error(detail ?? `Save failed (${response.status}).`);
      }

      const saved = (await response.json()) as {
        bytes: number;
        location: string;
      };

      setState({
        phase: "saved",
        bytes: saved.bytes,
        files: snapshot.fileCount,
        location: saved.location,
      });
    } catch (error) {
      setState({
        phase: "error",
        message:
          error instanceof Error ? error.message : "Failed to save a snapshot.",
      });
    }
  }, [projectId, wc]);

  const saving = state.phase === "saving";
  const disabled = saving || status !== "ready" || projectId === undefined;

  return (
    <div className="flex items-center gap-2" data-testid="save-project">
      <button
        type="button"
        data-testid="save-project-button"
        onClick={() => void save()}
        disabled={disabled}
        className="rounded-md border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
      >
        {saving ? `Saving ${state.files} files…` : "Save project"}
      </button>

      {state.phase === "saved" && (
        <span
          data-testid="save-project-result"
          className="max-w-[22rem] truncate text-xs text-emerald-600 dark:text-emerald-400"
          title={state.location}
        >
          Saved {state.files} files ({state.bytes} B)
        </span>
      )}

      {state.phase === "error" && (
        <span
          data-testid="save-project-error"
          className="max-w-[22rem] truncate text-xs text-destructive"
          title={state.message}
        >
          {state.message}
        </span>
      )}
    </div>
  );
}
