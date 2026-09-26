"use client";

import type { WebContainer } from "@webcontainer/api";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { tarToFileSystemTree } from "@/lib/tar";

export const STARTER_PROJECT = {
  "package.json": {
    file: {
      contents: `${JSON.stringify(
        {
          name: "starter",
          private: true,
          version: "1.0.0",
          scripts: { start: "node index.js" },
        },
        null,
        2,
      )}\n`,
    },
  },
  "index.js": {
    file: {
      contents: `const greeting = "Hello from a WebContainer";\n\nconsole.log(greeting);\n`,
    },
  },
} as const;

export type WebContainerStatus = "booting" | "restoring" | "ready" | "error";

export type RestoreSource = "starter" | "snapshot";

type WebContainerContextValue = {
  wc: WebContainer | null;
  status: WebContainerStatus;
  error: string | null;
  restoredFrom: RestoreSource | null;
  /**
   * Bumped when something outside `wc.fs` changed the workspace, such as a git
   * clone running in a spawned process. The file tree is not a live watcher, so
   * it uses this to know when to re-list.
   */
  fileRevision: number;
  refreshFiles: () => void;
};

const WebContainerContext = createContext<WebContainerContextValue>({
  wc: null,
  status: "booting",
  error: null,
  restoredFrom: null,
  fileRevision: 0,
  refreshFiles: () => {},
});

export function useWebContainer() {
  return useContext(WebContainerContext);
}

export function WebContainerProvider({
  children,
  projectId,
}: {
  children: React.ReactNode;
  projectId?: number;
}) {
  const [status, setStatus] = useState<WebContainerStatus>("booting");
  const [error, setError] = useState<string | null>(null);
  const [restoredFrom, setRestoredFrom] = useState<RestoreSource | null>(null);
  const [fileRevision, setFileRevision] = useState(0);
  const refreshFiles = useCallback(
    () => setFileRevision((value) => value + 1),
    [],
  );
  const [wc, setWc] = useState<WebContainer | null>(null);
  const bootPromiseRef = useRef<Promise<WebContainer> | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      if (typeof window === "undefined") {
        return;
      }

      if (!window.crossOriginIsolated) {
        setStatus("error");
        setError(
          "This page is not cross-origin isolated, so WebContainers cannot boot. Check the Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers in next.config.ts, and note that WebContainers require a Chromium-based browser.",
        );
        return;
      }

      try {
        const { WebContainer } = await import("@webcontainer/api");

        bootPromiseRef.current ??= WebContainer.boot();
        const instance = await bootPromiseRef.current;

        if (cancelled) {
          return;
        }

        if (projectId !== undefined) {
          setStatus("restoring");

          let restored = false;

          try {
            const response = await fetch(
              `/api/projects/${projectId}/snapshot`,
              {
                cache: "no-store",
              },
            );

            if (response.ok) {
              const buffer = new Uint8Array(await response.arrayBuffer());
              const tree = tarToFileSystemTree(buffer);

              if (Object.keys(tree).length > 0) {
                await instance.mount(tree);
                restored = true;
              }
            }
          } catch (restoreError) {
            console.warn(
              "Snapshot restore failed, falling back to the starter project.",
              restoreError,
            );
          }

          if (cancelled) {
            return;
          }

          if (restored) {
            setRestoredFrom("snapshot");
            setWc(instance);
            setStatus("ready");
            return;
          }

          setRestoredFrom("starter");
        }

        await instance.mount(structuredClone(STARTER_PROJECT));
        setWc(instance);
        setStatus("ready");
      } catch (bootError) {
        if (cancelled) {
          return;
        }
        setStatus("error");
        setError(
          bootError instanceof Error
            ? bootError.message
            : "Failed to boot the WebContainer.",
        );
      }
    }

    void boot();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <WebContainerContext.Provider
      value={{
        wc,
        status,
        error,
        restoredFrom,
        fileRevision,
        refreshFiles,
      }}
    >
      {children}
    </WebContainerContext.Provider>
  );
}
