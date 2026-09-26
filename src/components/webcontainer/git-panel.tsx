"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ContainerGitStatus,
  containerGitAttach,
  containerGitClone,
  containerGitCommitAndPush,
  containerGitStatus,
  isGitError,
} from "@/lib/git/container-git";
import { useWebContainer } from "./webcontainer-provider";

type GitConnection = {
  repo: string;
  branch: string;
  remoteUrl: string;
  updatedAt: string;
};

type GitRepo = {
  slug: string;
  description: string | null;
  defaultBranch: string;
  updatedAt: string | null;
  stars: number;
};

type PanelState =
  | { phase: "idle" }
  | { phase: "working"; message: string }
  | { phase: "message"; tone: "good" | "bad"; text: string }
  | { phase: "error"; message: string };

export function GitPanel({
  projectId,
  githubToken,
  githubLogin,
}: {
  projectId: number;
  githubToken: string | null;
  githubLogin: string | null;
}) {
  const { wc, status: containerStatus, refreshFiles } = useWebContainer();

  const [connection, setConnection] = useState<GitConnection | null>(null);
  const [gitStatus, setGitStatus] = useState<ContainerGitStatus | null>(null);
  const [hasGitDir, setHasGitDir] = useState<boolean | null>(null);
  const attachAttempted = useRef<string | null>(null);
  const [repos, setRepos] = useState<GitRepo[] | null>(null);
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [message, setMessage] = useState("");
  const [state, setState] = useState<PanelState>({ phase: "idle" });
  const [open, setOpen] = useState(false);

  const working = state.phase === "working";

  const readConnection = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}/git`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return;
    }

    const data = (await response.json()) as {
      connection: GitConnection | null;
    };
    setConnection(data.connection);

    if (data.connection) {
      setRepo(data.connection.repo);
      setBranch(data.connection.branch);
    }
  }, [projectId]);

  useEffect(() => {
    void readConnection();
  }, [readConnection]);

  const refreshStatus = useCallback(async () => {
    if (!wc || containerStatus !== "ready") {
      return;
    }
    const result = await containerGitStatus(wc, ".");
    if (!isGitError(result)) {
      setGitStatus(result);
    }
  }, [containerStatus, wc]);

  useEffect(() => {
    if (!wc || containerStatus !== "ready") {
      return;
    }

    // `wc.fs` has no exists(), but readdir is enough and avoids the cost of
    // running the git runner, which installs isomorphic-git on first use.
    void wc.fs
      .readdir(".")
      .then((entries) => {
        const present = entries.includes(".git");
        setHasGitDir(present);
        if (present) {
          void refreshStatus();
        }
      })
      .catch(() => setHasGitDir(false));
  }, [containerStatus, refreshStatus, wc]);

  /**
   * Snapshots deliberately exclude .git, so a restored project comes back
   * without one. Re-fetch just the git metadata and graft it in, which leaves
   * the restored files in place as local changes ready to be pushed.
   */
  useEffect(() => {
    if (
      !wc ||
      !connection ||
      hasGitDir !== false ||
      containerStatus !== "ready"
    ) {
      return;
    }

    const key = `${connection.repo}@${connection.branch}`;
    if (attachAttempted.current === key) {
      return;
    }
    attachAttempted.current = key;

    void (async () => {
      setState({ phase: "working", message: "Re-attaching the repository…" });

      const result = await containerGitAttach(
        wc,
        ".",
        {
          url: connection.remoteUrl,
          branch: connection.branch,
          token: githubToken ?? undefined,
        },
        (text) => setState({ phase: "working", message: text }),
      );

      if (isGitError(result)) {
        setState({ phase: "error", message: result.error });
        return;
      }

      setHasGitDir(true);
      await refreshStatus();
      setState({
        phase: "message",
        tone: "good",
        text: `Re-attached ${connection.repo} (${connection.branch})`,
      });
    })();
  }, [connection, containerStatus, githubToken, hasGitDir, refreshStatus, wc]);

  const loadRepos = useCallback(async () => {
    if (repos) {
      return;
    }

    const response = await fetch("/api/github/repos", { cache: "no-store" });

    if (response.status === 409) {
      setState({
        phase: "error",
        message: "Reconnect GitHub to list your repositories.",
      });
      return;
    }

    if (!response.ok) {
      const detail = await response
        .json()
        .then((data: { error?: string }) => data.error)
        .catch(() => null);
      setState({
        phase: "error",
        message: detail ?? `Could not load repositories (${response.status}).`,
      });
      return;
    }

    const data = (await response.json()) as { repos: GitRepo[] };
    setRepos(data.repos);
  }, [repos]);

  const saveConnection = useCallback(
    async (nextRepo: string, nextBranch: string) => {
      const response = await fetch(`/api/projects/${projectId}/git`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: nextRepo, branch: nextBranch }),
      });

      const data = (await response.json().catch(() => ({}))) as {
        connection?: GitConnection;
        error?: string;
      };

      if (!response.ok || !data.connection) {
        throw new Error(data.error ?? "Could not save the Git connection.");
      }

      setConnection(data.connection);
      return data.connection;
    },
    [projectId],
  );

  const connect = useCallback(
    async (input: { repo: string; branch: string }) => {
      if (!wc) {
        setState({
          phase: "error",
          message: "The workspace is still starting.",
        });
        return;
      }

      setState({ phase: "working", message: "Cloning…" });

      const saved = await saveConnection(input.repo, input.branch);

      const result = await containerGitClone(
        wc,
        ".",
        {
          url: saved.remoteUrl,
          branch: saved.branch,
          token: githubToken ?? undefined,
        },
        (text) => setState({ phase: "working", message: text }),
      );

      if (isGitError(result)) {
        setState({ phase: "error", message: result.error });
        return;
      }

      refreshFiles();
      await refreshStatus();
      setState({
        phase: "message",
        tone: "good",
        text: `Cloned ${saved.repo} (${saved.branch})`,
      });
    },
    [githubToken, refreshFiles, refreshStatus, saveConnection, wc],
  );

  const push = useCallback(async () => {
    if (!wc) {
      setState({ phase: "error", message: "The workspace is still starting." });
      return;
    }

    const text = message.trim() || "Update from codeagent";
    setState({ phase: "working", message: "Committing and pushing…" });

    const result = await containerGitCommitAndPush(wc, ".", {
      message: text,
      token: githubToken ?? undefined,
      author: githubLogin
        ? {
            name: githubLogin,
            email: `${githubLogin}@users.noreply.github.com`,
          }
        : undefined,
    });

    await refreshStatus();

    if (isGitError(result)) {
      setState({
        phase: "error",
        message: result.committed
          ? `Committed, but the push failed. ${result.error}`
          : result.error,
      });
      return;
    }

    if (!result.committed) {
      setState({
        phase: "message",
        tone: "bad",
        text: result.reason ?? "Nothing to push.",
      });
      return;
    }

    setMessage("");
    setState({
      phase: "message",
      tone: "good",
      text: result.pushed
        ? `Pushed ${result.branch} (${result.oid?.slice(0, 7) ?? "committed"})`
        : `Committed ${result.oid?.slice(0, 7) ?? ""} on ${result.branch}`,
    });
  }, [githubLogin, githubToken, message, refreshStatus, wc]);

  const disconnect = useCallback(async () => {
    await fetch(`/api/projects/${projectId}/git`, { method: "DELETE" });
    setConnection(null);
    setGitStatus(null);
    setHasGitDir(null);
    attachAttempted.current = null;
    setState({ phase: "idle" });
  }, [projectId]);

  const changedCount = gitStatus?.changed.length ?? 0;
  const connected = connection !== null && (hasGitDir ?? false);

  if (!githubToken) {
    return (
      <div className="flex items-center gap-2" data-testid="git-panel">
        <a
          href="/api/auth/signin/github"
          data-testid="git-connect"
          className="rounded-md border px-2 py-1 text-xs hover:bg-accent"
        >
          Connect GitHub
        </a>
      </div>
    );
  }

  return (
    <div className="relative" data-testid="git-panel">
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="git-toggle"
          onClick={() => setOpen((value) => !value)}
          className="rounded-md border px-2 py-1 text-xs hover:bg-accent"
        >
          {connected
            ? `Git: ${connection?.repo} (${connection?.branch})`
            : "Git: not connected"}
        </button>

        {connected && changedCount > 0 && (
          <span
            data-testid="git-changed"
            className="text-xs text-amber-600 dark:text-amber-400"
          >
            {changedCount} changed
          </span>
        )}
      </div>

      {open && (
        <div
          data-testid="git-popover"
          className="absolute right-0 z-50 mt-2 w-80 rounded-md border bg-popover p-3 text-xs shadow-md"
        >
          {connected ? (
            <div className="flex flex-col gap-2">
              <p className="text-muted-foreground">
                Connected to{" "}
                <span className="font-medium text-foreground">
                  {connection?.repo}@{connection?.branch}
                </span>
                .
              </p>

              {changedCount > 0 && (
                <ul
                  data-testid="git-changed-list"
                  className="max-h-32 overflow-auto rounded border p-1 font-mono"
                >
                  {(gitStatus?.changed ?? []).slice(0, 25).map((path) => (
                    <li key={path} className="truncate">
                      {path}
                    </li>
                  ))}
                  {changedCount > 25 && <li>…and {changedCount - 25} more</li>}
                </ul>
              )}

              {gitStatus?.ahead ? (
                <p className="text-muted-foreground">
                  {gitStatus.ahead} commit(s) not yet pushed.
                </p>
              ) : null}

              <input
                data-testid="git-commit-message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Commit message"
                className="w-full rounded border bg-background px-2 py-1"
              />

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="git-push"
                  onClick={() => void push()}
                  disabled={working || containerStatus !== "ready"}
                  className="rounded-md border px-2 py-1 hover:bg-accent disabled:opacity-50"
                >
                  {working ? "Working…" : "Commit & push"}
                </button>

                <button
                  type="button"
                  data-testid="git-disconnect"
                  onClick={() => void disconnect()}
                  className="rounded-md border px-2 py-1 text-muted-foreground hover:bg-accent"
                >
                  Disconnect
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-muted-foreground">
                Clone a public repository into this project. Cloning replaces
                the files in the workspace.
              </p>

              {repos === null ? (
                <button
                  type="button"
                  data-testid="git-load-repos"
                  onClick={() => void loadRepos()}
                  className="rounded-md border px-2 py-1 hover:bg-accent"
                >
                  Load my repositories
                </button>
              ) : (
                <>
                  <select
                    data-testid="git-repo"
                    value={repo}
                    onChange={(event) => {
                      const next = event.target.value;
                      setRepo(next);
                      const match = repos.find((entry) => entry.slug === next);
                      if (match) {
                        setBranch(match.defaultBranch);
                      }
                    }}
                    className="w-full rounded border bg-background px-2 py-1"
                  >
                    <option value="">Choose a repository…</option>
                    {repos.map((entry) => (
                      <option key={entry.slug} value={entry.slug}>
                        {entry.slug}
                      </option>
                    ))}
                  </select>

                  {repos.length === 0 && (
                    <p className="text-muted-foreground">
                      No public repositories found for this account.
                    </p>
                  )}

                  <label className="flex items-center gap-2">
                    Branch
                    <input
                      data-testid="git-branch"
                      value={branch}
                      onChange={(event) => setBranch(event.target.value)}
                      className="w-full rounded border bg-background px-2 py-1"
                    />
                  </label>

                  <button
                    type="button"
                    data-testid="git-clone"
                    onClick={() => void connect({ repo, branch })}
                    disabled={
                      working || repo === "" || containerStatus !== "ready"
                    }
                    className="rounded-md border px-2 py-1 hover:bg-accent disabled:opacity-50"
                  >
                    {working ? "Working…" : "Clone repository"}
                  </button>
                </>
              )}
            </div>
          )}

          {state.phase === "working" && (
            <p
              data-testid="git-progress"
              className="mt-2 text-muted-foreground"
            >
              {state.message}
            </p>
          )}

          {state.phase === "message" && (
            <p
              data-testid="git-result"
              className={`mt-2 ${
                state.tone === "good"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground"
              }`}
            >
              {state.text}
            </p>
          )}

          {state.phase === "error" && (
            <p
              data-testid="git-error"
              className="mt-2 text-destructive"
              title={state.message}
            >
              {state.message.length > 140
                ? `${state.message.slice(0, 140)}…`
                : state.message}
            </p>
          )}

          {containerStatus === "error" && (
            <p className="mt-2 text-muted-foreground">
              The workspace failed to start, so git is unavailable.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
