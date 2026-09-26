"use client";

import { loader } from "@monaco-editor/react";
import type { WebContainer } from "@webcontainer/api";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { ChatPanel } from "@/components/chat/chat-panel";
import { ResizeHandle } from "./resize-handle";
import { isHiddenDirectory } from "./snapshot";
import { TerminalPanel } from "./terminal-panel";
import { useWebContainer } from "./webcontainer-provider";

loader.config({ paths: { vs: "/monaco/vs" } });

const Editor = dynamic(
  () => import("@monaco-editor/react").then((mod) => mod.Editor),
  {
    ssr: false,
    loading: () => (
      <div className="p-4 text-sm text-muted-foreground">Loading editor…</div>
    ),
  },
);

const MIN_TREE_WIDTH = 140;
const MAX_TREE_WIDTH = 420;
const MIN_CHAT_WIDTH = 260;
const MAX_CHAT_WIDTH = 560;
const MIN_TERMINAL_HEIGHT = 80;
const MAX_TERMINAL_HEIGHT = 520;

async function listFiles(wc: WebContainer, dir = "/"): Promise<string[]> {
  const entries = await wc.fs.readdir(dir, { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries) {
    // Skipping these outright matters: after `npm install` node_modules holds
    // hundreds of files, and a cloned .git holds its whole object store.
    if (isHiddenDirectory(entry.name)) {
      continue;
    }

    const path = dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;

    if (entry.isDirectory()) {
      found.push(...(await listFiles(wc, path)));
    } else {
      found.push(path);
    }
  }

  return found.sort();
}

export function WebContainerEditor({ projectId }: { projectId?: number }) {
  const { wc, status, error: bootError, fileRevision } = useWebContainer();
  const [files, setFiles] = useState<string[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [contents, setContents] = useState("");
  const [savedContents, setSavedContents] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [treeWidth, setTreeWidth] = useState(200);
  const [chatWidth, setChatWidth] = useState(320);
  const [terminalHeight, setTerminalHeight] = useState(200);

  const refreshFiles = useCallback(async (instance: WebContainer) => {
    setFiles(await listFiles(instance));
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: fileRevision is a deliberate cache-busting signal, not a value read here. Git runs in a spawned process, so the tree is not a live watcher and has to be told to re-list.
  useEffect(() => {
    if (wc && status === "ready") {
      void refreshFiles(wc);
    }
  }, [fileRevision, refreshFiles, status, wc]);

  const selectFile = useCallback(
    async (path: string) => {
      if (!wc) {
        return;
      }

      try {
        const text = await wc.fs.readFile(path, "utf-8");
        setSelectedPath(path);
        setContents(text);
        setSavedContents(text);
        setIsDirty(false);
      } catch (readError) {
        setError(
          readError instanceof Error
            ? `Could not read ${path}: ${readError.message}`
            : `Could not read ${path}`,
        );
      }
    },
    [wc],
  );

  const saveFile = useCallback(async () => {
    if (!wc || !selectedPath) {
      return;
    }

    try {
      await wc.fs.writeFile(selectedPath, contents);
      setSavedContents(contents);
      setIsDirty(false);
      await refreshFiles(wc);
    } catch (writeError) {
      setError(
        writeError instanceof Error
          ? `Could not save ${selectedPath}: ${writeError.message}`
          : `Could not save ${selectedPath}`,
      );
    }
  }, [contents, refreshFiles, selectedPath, wc]);

  if (status === "error") {
    return (
      <div className="rounded-md border border-destructive/40 p-4 text-sm">
        <p className="font-medium">WebContainer unavailable</p>
        <p className="mt-2 text-muted-foreground">{bootError}</p>
      </div>
    );
  }

  if (status === "booting") {
    return (
      <div className="rounded-md border p-4 text-sm text-muted-foreground">
        Booting WebContainer…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <div className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div
        data-testid="workbench"
        className="flex flex-col overflow-hidden rounded-md border"
        style={{ height: 720 }}
      >
        <div className="flex min-h-0 flex-1">
          <aside
            data-testid="file-tree"
            className="flex min-w-0 shrink-0 flex-col overflow-y-auto"
            style={{ width: treeWidth }}
          >
            <h2 className="sticky top-0 border-b bg-background px-3 py-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Files
            </h2>
            <ul className="p-2 text-sm">
              {files.length === 0 && (
                <li className="px-2 py-1 text-muted-foreground">No files</li>
              )}
              {files.map((path) => (
                <li key={path}>
                  <button
                    type="button"
                    onClick={() => void selectFile(path)}
                    className={`w-full truncate rounded px-2 py-1 text-left hover:bg-accent ${
                      path === selectedPath ? "bg-accent font-medium" : ""
                    }`}
                  >
                    {path}
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          <ResizeHandle
            axis="x"
            label="Resize file tree"
            value={treeWidth}
            min={MIN_TREE_WIDTH}
            max={MAX_TREE_WIDTH}
            onChange={setTreeWidth}
          />

          <section className="flex min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
              <span className="truncate text-sm text-muted-foreground">
                {selectedPath ?? "Select a file"}
              </span>
              <button
                type="button"
                onClick={() => void saveFile()}
                disabled={!selectedPath || !isDirty}
                className="rounded-md border px-3 py-1 text-sm hover:bg-accent disabled:opacity-50"
              >
                {isDirty ? "Save" : "Saved"}
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <Editor
                path={selectedPath ?? undefined}
                value={contents}
                language={
                  selectedPath?.endsWith(".json") ? "json" : "javascript"
                }
                theme="vs-dark"
                onChange={(value) => {
                  setContents(value ?? "");
                  setIsDirty((value ?? "") !== savedContents);
                }}
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  scrollBeyondLastLine: false,
                }}
              />
            </div>
          </section>

          <ResizeHandle
            axis="x"
            label="Resize chat panel"
            value={chatWidth}
            min={MIN_CHAT_WIDTH}
            max={MAX_CHAT_WIDTH}
            onChange={setChatWidth}
          />

          <aside
            data-testid="chat-panel"
            className="flex min-w-0 shrink-0 flex-col overflow-hidden"
            style={{ width: chatWidth }}
          >
            <ChatPanel projectId={projectId} />
          </aside>
        </div>

        <ResizeHandle
          axis="y"
          label="Resize terminal"
          value={terminalHeight}
          min={MIN_TERMINAL_HEIGHT}
          max={MAX_TERMINAL_HEIGHT}
          onChange={setTerminalHeight}
        />

        <div data-testid="terminal-panel" style={{ height: terminalHeight }}>
          <TerminalPanel />
        </div>
      </div>
    </div>
  );
}
