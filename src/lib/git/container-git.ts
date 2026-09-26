import type { WebContainer } from "@webcontainer/api";

/**
 * Runs git inside the WebContainer.
 *
 * The container has no `git` binary and its `wc.fs` binding does not implement
 * `stat`/`lstat`, which isomorphic-git requires. So every operation is a
 * `node` child process in the container using the real `fs` module and the
 * Node HTTP client that ships with isomorphic-git.
 *
 * isomorphic-git is installed into the container on demand because the
 * workspace is ephemeral and `node_modules` does not survive a reload.
 */

/** Keep in sync with the `isomorphic-git` entry in package.json. */
const ISOGIT_VERSION = "1.42.2";

/** Lives inside node_modules so it is excluded from snapshots and the tree. */
const RUNNER_PATH = "node_modules/.cache/codeagent-git-runner.cjs";

/** Prefix that marks the single line of JSON the runner prints. */
const RESULT_MARKER = "__CODEX_GIT__";

/**
 * The runner, as source. Written to disk in the container and executed with
 * `node`. It reads a JSON request from argv[2] and writes one JSON line to
 * stdout, prefixed with RESULT_MARKER so host logs and npm noise can be
 * ignored.
 */
const RUNNER_SOURCE = String.raw`
"use strict";
const path = require("path");

const MARKER = ${JSON.stringify(RESULT_MARKER)};

function emit(payload) {
  process.stdout.write("\n" + MARKER + JSON.stringify(payload) + "\n");
}

function requireGit() {
  try {
    return {
      git: require("isomorphic-git"),
      http: require("isomorphic-git/http/node"),
      fs: require("fs"),
    };
  } catch (error) {
    emit({ ok: false, error: "isomorphic-git is not installed in the container." });
    process.exit(0);
  }
}

/** Turns a raw isomorphic-git HTTP error into something worth showing. */
function describeError(error) {
  const message = (error && (error.message || String(error))) || "Git failed.";

  if (/401/.test(message)) {
    return (
      "GitHub rejected the credentials (401). Reconnect your account so it can " +
      "grant the public_repo scope, then try again."
    );
  }

  if (/403/.test(message)) {
    return (
      "GitHub refused the request (403). This is usually an expired token, a " +
      "repository you do not have write access to, or branch protection."
    );
  }

  if (/404/.test(message)) {
    return "That repository or branch was not found (404). Check the name and branch.";
  }

  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT/.test(message)) {
    return "Could not reach GitHub. Check your connection and try again.";
  }

  return message.length > 300 ? message.slice(0, 300) : message;
}

function onAuth(token) {
  return function () {
    return { username: "x-access-token", password: token };
  };
}

async function readme(dir) {
  const fs = require("fs");
  try {
    return fs.readFileSync(path.join(dir, "README.md"), "utf8").slice(0, 200);
  } catch {
    return null;
  }
}

function isIgnoredPath(filepath) {
  return filepath === "node_modules" || filepath.indexOf("node_modules/") === 0;
}

/**
 * statusMatrix rows are [filepath, head, workdir, stage], where 0 means the
 * path is absent, 1 means present and 2 means present but changed. Verified
 * against \`git status --porcelain\` for modified, deleted, staged-only,
 * untracked and nested-modified paths.
 */
function isChangedRow(row) {
  return row[1] !== row[2] || row[2] !== row[3];
}

/** A path is staged relative to HEAD when the index and HEAD disagree. */
function isStagedRow(row) {
  return row[1] !== row[3];
}

/** Stages every modified, untracked and removed path in the worktree. */
async function stageAll(git, fs, dir) {
  const matrix = await git.statusMatrix({ fs: fs, dir: dir });
  let touched = 0;

  for (const row of matrix) {
    const filepath = row[0];
    const head = row[1];
    const workdir = row[2];
    const stage = row[3];

    // A clean tracked file is [1, 1, 1]; re-adding those is wasted work and
    // would inflate the reported count.
    if (!isChangedRow(row) || isIgnoredPath(filepath)) {
      continue;
    }

    // Gone from disk: drop it from the index.
    if (workdir === 0 && (head !== 0 || stage !== 0)) {
      await git.remove({ fs: fs, dir: dir, filepath: filepath });
      touched += 1;
      continue;
    }

    await git.add({ fs: fs, dir: dir, filepath: filepath });
    touched += 1;
  }

  return touched;
}

/**
 * isDescendent has to do the work: \`git.status\` in isomorphic-git is a
 * per-file API and has no \`track\` option.
 */
async function countAheadBehind(git, fs, dir, branch, remoteRef) {
  const headOid = await git.resolveRef({ fs: fs, dir: dir, ref: "HEAD" });

  let remoteOid = null;
  try {
    remoteOid = await git.resolveRef({ fs: fs, dir: dir, ref: remoteRef });
  } catch {
    return { ahead: 0, behind: 0, tracked: false };
  }

  if (!remoteOid || remoteOid === headOid) {
    return { ahead: 0, behind: 0, tracked: true };
  }

  let ahead = 0;
  let behind = 0;

  if (await git.isDescendent({ fs: fs, dir: dir, oid: headOid, ancestor: remoteOid, depth: 500 })) {
    const log = await git.log({ fs: fs, dir: dir, ref: "HEAD", depth: 500 });
    const index = log.findIndex(function (entry) { return entry.oid === remoteOid; });
    ahead = index === -1 ? 0 : index;
  }

  if (await git.isDescendent({ fs: fs, dir: dir, oid: remoteOid, ancestor: headOid, depth: 500 })) {
    const log = await git.log({ fs: fs, dir: dir, ref: remoteRef, depth: 500 });
    const index = log.findIndex(function (entry) { return entry.oid === headOid; });
    behind = index === -1 ? 0 : index;
  }

  return { ahead: ahead, behind: behind, tracked: true };
}

async function main() {
  const request = JSON.parse(process.argv[2] || "{}");
  const op = request.op;
  const dir = request.dir;
  // The token is only attached to push. Cloning and re-attaching a public
  // repository works without credentials, so there is no reason to hand the
  // token to the remote on a read.
  const token = request.token || "";
  const auth = token ? onAuth(token) : undefined;

  const loaded = requireGit();
  if (!loaded) {
    return;
  }
  const git = loaded.git;
  const httpModule = loaded.http;
  const http = httpModule.default || httpModule;
  const fs = loaded.fs;

  if (op === "ping") {
    emit({ ok: true, ready: true });
    return;
  }

  const connected = fs.existsSync(path.join(dir, ".git"));

  if (op === "status") {
    if (!connected) {
      emit({ ok: true, connected: false, branch: null, changed: [], ahead: 0, behind: 0 });
      return;
    }

    const matrix = await git.statusMatrix({ fs: fs, dir: dir });
    const changed = matrix
      .filter(function (row) { return !isIgnoredPath(row[0]) && isChangedRow(row); })
      .map(function (row) { return row[0]; });

    let branch = null;
    try {
      // Without fullname this is the short name, e.g. "main" not
      // "refs/heads/main", which is what the push refspec needs.
      branch = await git.currentBranch({ fs: fs, dir: dir });
    } catch {
      branch = null;
    }

    let head = null;
    try {
      head = await git.resolveRef({ fs: fs, dir: dir, ref: "HEAD" });
    } catch {
      head = null;
    }

    let remote = null;
    try {
      const remotes = await git.listRemotes({ fs: fs, dir: dir });
      const origin = remotes.find(function (entry) { return entry.remote === "origin"; });
      remote = origin ? origin.url : null;
    } catch {
      remote = null;
    }

    const tracking = branch
      ? await countAheadBehind(git, fs, dir, branch, "refs/remotes/origin/" + branch)
      : { ahead: 0, behind: 0, tracked: false };

    emit({
      ok: true,
      connected: true,
      branch: branch,
      head: head,
      changed: changed,
      ahead: tracking.ahead,
      behind: tracking.behind,
      tracked: tracking.tracked,
      remote: remote,
    });
    return;
  }

  if (op === "clone") {
    if (connected) {
      emit({ ok: false, error: "This project is already a git repository." });
      return;
    }

    // The workspace arrives full of starter or restored files, and a checkout
    // on top of them collides. Clear the project first but keep node_modules,
    // which holds isomorphic-git and would otherwise cost another install.
    for (const entry of fs.readdirSync(dir)) {
      if (entry === "node_modules") {
        continue;
      }
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }

    await git.clone({
      fs: fs,
      http: http,
      dir: dir,
      url: request.url,
      ref: request.branch,
      singleBranch: true,
    });

    const head = await git.resolveRef({ fs: fs, dir: dir, ref: "HEAD" });
    emit({ ok: true, connected: true, branch: request.branch, head: head, readme: await readme(dir) });
    return;
  }

  if (op === "attach") {
    // Used after a snapshot restore: the snapshot keeps the working tree but
    // not .git, so fetch a fresh .git without touching any files. The restored
    // files then show up as local modifications against the remote HEAD, which
    // is exactly what should be pushed.
    if (connected) {
      emit({ ok: true, connected: true, already: true });
      return;
    }

    const staging = dir + ".gitattach";
    fs.rmSync(staging, { recursive: true, force: true });

    await git.clone({
      fs: fs,
      http: http,
      dir: staging,
      url: request.url,
      ref: request.branch,
      singleBranch: true,
      noCheckout: true,
    });

    fs.renameSync(path.join(staging, ".git"), path.join(dir, ".git"));
    fs.rmSync(staging, { recursive: true, force: true });

    emit({ ok: true, connected: true, restored: true });
    return;
  }

  if (op === "commit") {
    if (!connected) {
      emit({ ok: false, error: "This project is not a git repository yet." });
      return;
    }

    const branch = await git.currentBranch({ fs: fs, dir: dir });
    if (!branch) {
      emit({ ok: false, error: "Detached HEAD: check out a branch before pushing." });
      return;
    }

    const touched = await stageAll(git, fs, dir);

    // git.status is per-file in this version, so re-read the matrix and
    // compare the index against HEAD instead.
    const after = await git.statusMatrix({ fs: fs, dir: dir });
    const hasStagedChanges = after.some(function (row) {
      return !isIgnoredPath(row[0]) && isStagedRow(row);
    });

    const remoteRef = "refs/remotes/origin/" + branch;
    const tracking = await countAheadBehind(git, fs, dir, branch, remoteRef);

    if (!hasStagedChanges && tracking.ahead === 0) {
      emit({
        ok: true,
        committed: false,
        pushed: false,
        reason: "No changes to push.",
        changed: [],
        branch: branch,
      });
      return;
    }

    let oid = null;
    if (hasStagedChanges) {
      const author = request.author || {};
      oid = await git.commit({
        fs: fs,
        dir: dir,
        message: request.message,
        author: {
          name: author.name || "codeagent",
          email: author.email || "codeagent@users.noreply.github.com",
        },
      });
    }

    // Commit and push are reported separately on purpose. If the commit lands
    // but the push fails, saying only "push failed" would hide work that is
    // already saved, and clicking Push again would report nothing to do.
    try {
      await git.push({
        fs: fs,
        http: http,
        dir: dir,
        remote: "origin",
        ref: "refs/heads/" + branch,
        onAuth: auth,
      });
    } catch (error) {
      emit({
        ok: false,
        committed: Boolean(oid),
        pushed: false,
        branch: branch,
        oid: oid,
        stagedFiles: touched,
        error: describeError(error),
        name: error && error.name,
      });
      return;
    }

    emit({
      ok: true,
      committed: Boolean(oid),
      pushed: true,
      branch: branch,
      oid: oid,
      stagedFiles: touched,
    });
    return;
  }

  emit({ ok: false, error: "Unknown git operation: " + String(op) });
}

main().catch(function (error) {
  emit({ ok: false, error: describeError(error), name: error && error.name });
});
`;

/** Where the runner is written, relative to the project root. */
const RUNNER_RELATIVE_PATH = RUNNER_PATH;

export type ContainerGitStatus = {
  connected: boolean;
  branch: string | null;
  head?: string | null;
  changed: string[];
  ahead: number;
  behind: number;
  remote?: string | null;
};

export type ContainerGitError = {
  ok: false;
  error: string;
  name?: string;
  /**
   * Set when a commit landed but the push that followed it failed, so the UI
   * can say the work is saved rather than lost.
   */
  committed?: boolean;
};

export type ContainerGitResult<T> = T | ContainerGitError;

export function isGitError(
  result: ContainerGitResult<unknown>,
): result is ContainerGitError {
  return (result as { ok?: boolean }).ok === false;
}

/** Remembers which containers already have isomorphic-git installed. */
const readyContainers = new WeakMap<WebContainer, Promise<void>>();

async function readRunnerOutput(
  wc: WebContainer,
  payload: Record<string, unknown>,
  cwd: string,
): Promise<ContainerGitResult<Record<string, unknown>>> {
  const process = await wc.spawn(
    "node",
    [RUNNER_RELATIVE_PATH, JSON.stringify(payload)],
    {
      cwd,
      env: {},
    },
  );

  let output = "";
  const stream = process.output.pipeTo(
    new WritableStream({
      write(chunk) {
        output += chunk;
      },
    }),
  );

  const exitCode = await process.exit;
  await stream;

  const markerIndex = output.lastIndexOf(RESULT_MARKER);
  if (markerIndex === -1) {
    const tail = output.trim().split("\n").slice(-4).join(" ").slice(0, 300);
    return {
      ok: false,
      error:
        exitCode === 0
          ? `The container git runner produced no result. ${tail}`
          : `The container git runner exited with code ${exitCode}. ${tail}`,
    };
  }

  const line = output.slice(markerIndex + RESULT_MARKER.length).split("\n")[0];
  try {
    return JSON.parse(line) as ContainerGitResult<Record<string, unknown>>;
  } catch {
    return {
      ok: false,
      error: "The container git runner returned invalid JSON.",
    };
  }
}

/** Installs isomorphic-git in the container if it is not already present. */
export function ensureGitRuntime(
  wc: WebContainer,
  cwd: string,
  onProgress?: (message: string) => void,
): Promise<void> {
  const existing = readyContainers.get(wc);
  if (existing) {
    return existing;
  }

  const setup = (async () => {
    const probe = await wc.spawn(
      "node",
      ["-e", "require.resolve('isomorphic-git')"],
      { cwd, env: {} },
    );
    await probe.output.pipeTo(new WritableStream());
    if ((await probe.exit) === 0) {
      return;
    }

    onProgress?.(
      `Installing isomorphic-git ${ISOGIT_VERSION} in the workspace…`,
    );

    const install = await wc.spawn(
      "npm",
      [
        "install",
        `isomorphic-git@${ISOGIT_VERSION}`,
        "--no-audit",
        "--no-fund",
      ],
      { cwd, env: {} },
    );
    let installOutput = "";
    await install.output.pipeTo(
      new WritableStream({
        write(chunk) {
          installOutput += chunk;
        },
      }),
    );

    if ((await install.exit) !== 0) {
      const tail = installOutput
        .trim()
        .split("\n")
        .slice(-5)
        .join(" ")
        .slice(0, 300);
      throw new Error(`Could not install isomorphic-git. ${tail}`);
    }

    await wc.fs.mkdir("node_modules/.cache", { recursive: true });
    readyContainers.set(wc, Promise.resolve());
  })();

  // Do not cache failures: a later attempt should retry the install.
  readyContainers.set(
    wc,
    setup.catch(() => undefined),
  );
  return setup;
}

async function run<T>(
  wc: WebContainer,
  cwd: string,
  token: string | undefined,
  payload: Record<string, unknown>,
  onProgress?: (message: string) => void,
): Promise<ContainerGitResult<T>> {
  try {
    await ensureGitRuntime(wc, cwd, onProgress);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not set up git.",
    };
  }

  await wc.fs.writeFile(RUNNER_RELATIVE_PATH, RUNNER_SOURCE);

  return (await readRunnerOutput(
    wc,
    { ...payload, dir: cwd, token },
    cwd,
  )) as ContainerGitResult<T>;
}

export function containerGitStatus(
  wc: WebContainer,
  cwd: string,
): Promise<ContainerGitResult<ContainerGitStatus>> {
  return run<ContainerGitStatus>(wc, cwd, undefined, { op: "status" });
}

export function containerGitClone(
  wc: WebContainer,
  cwd: string,
  input: { url: string; branch: string; token?: string },
  onProgress?: (message: string) => void,
): Promise<ContainerGitResult<{ branch: string; head: string }>> {
  return run<{ branch: string; head: string }>(
    wc,
    cwd,
    input.token,
    { op: "clone", url: input.url, branch: input.branch },
    onProgress,
  );
}

export function containerGitAttach(
  wc: WebContainer,
  cwd: string,
  input: { url: string; branch: string; token?: string },
  onProgress?: (message: string) => void,
): Promise<ContainerGitResult<{ restored: boolean }>> {
  return run<{ restored: boolean }>(
    wc,
    cwd,
    input.token,
    { op: "attach", url: input.url, branch: input.branch },
    onProgress,
  );
}

export function containerGitCommitAndPush(
  wc: WebContainer,
  cwd: string,
  input: {
    message: string;
    token?: string;
    author?: { name?: string; email?: string };
  },
  onProgress?: (message: string) => void,
): Promise<
  ContainerGitResult<{
    committed: boolean;
    pushed?: boolean;
    reason?: string;
    branch?: string;
    oid?: string;
    stagedFiles?: number;
  }>
> {
  return run(
    wc,
    cwd,
    input.token,
    { op: "commit", message: input.message, author: input.author },
    onProgress,
  );
}
