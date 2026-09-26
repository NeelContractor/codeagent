import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { gitConnections } from "@/db/schema";

/**
 * GitHub helpers.
 *
 * The remote URL is always derived here from a validated `owner/repo` slug and
 * is never accepted from the client. That matters: the WebContainer is handed
 * the user's OAuth token, so a client-chosen URL could be pointed at an
 * attacker-controlled host and used to exfiltrate it.
 */

const GITHUB_API = "https://api.github.com";
const GITHUB_CLONE_BASE = "https://github.com";

/** GitHub owner: alphanumerics and single hyphens, max 39 chars. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/** GitHub repo name: alphanumerics, `.`, `_`, `-`, max 100 chars. */
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Mirrors `git check-ref-format`: no control characters, no space, and none of
 * the sequences git reserves for ref syntax.
 */
const FORBIDDEN_BRANCH_SEQUENCES = ["..", "@{"];

function isValidBranchName(branch: string): boolean {
  for (let index = 0; index < branch.length; index += 1) {
    const code = branch.charCodeAt(index);
    const char = branch[index];

    // Control characters and DEL are never valid in a ref name.
    if (code < 0x20 || code === 0x7f) {
      return false;
    }

    if (" ~^:?*[\\".includes(char)) {
      return false;
    }
  }

  if (
    FORBIDDEN_BRANCH_SEQUENCES.some((sequence) => branch.includes(sequence))
  ) {
    return false;
  }

  if (
    branch.startsWith("/") ||
    branch.startsWith("-") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("//") ||
    branch.endsWith(".lock")
  ) {
    return false;
  }

  return true;
}

export type RepoSlug = { owner: string; repo: string; slug: string };

/**
 * Parses `owner/repo` or a github.com URL into a slug, throwing if it is
 * anything other than a plain public GitHub repository.
 */
export function parseRepoSlug(input: string): RepoSlug {
  const raw = input.trim();
  if (raw.length === 0 || raw.length > 300) {
    throw new Error("Enter a repository as owner/repo.");
  }

  // Accept a pasted https URL, but only from github.com itself.
  let candidate = raw;
  if (raw.toLowerCase().startsWith("git@")) {
    if (!/^git@github\.com:/i.test(raw)) {
      throw new Error("Only github.com repositories are supported.");
    }
    candidate = raw.replace(/^git@github\.com:/i, "https://github.com/");
  }

  if (/^https?:\/\//i.test(candidate)) {
    const url = new URL(candidate);
    if (url.hostname.toLowerCase() !== "github.com") {
      throw new Error("Only github.com repositories are supported.");
    }
    if (url.protocol !== "https:") {
      throw new Error("Only https repository URLs are supported.");
    }
    candidate = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  }

  const segments = candidate.split("/").filter(Boolean);
  if (segments.length !== 2) {
    throw new Error("Enter a repository as owner/repo.");
  }

  const [owner, repo] = segments;
  if (!OWNER.test(owner)) {
    throw new Error(`"${owner}" is not a valid GitHub owner or organisation.`);
  }
  if (!REPO_NAME.test(repo) || repo === "." || repo === "..") {
    throw new Error(`"${repo}" is not a valid repository name.`);
  }

  return { owner, repo, slug: `${owner}/${repo}` };
}

export function parseBranch(input: string): string {
  const branch = input.trim();
  if (branch.length === 0 || branch.length > 255) {
    throw new Error("Enter a branch name.");
  }
  if (!isValidBranchName(branch)) {
    throw new Error(`"${branch}" is not a valid branch name.`);
  }
  return branch;
}

/** The clone URL for a slug. Constructed, never accepted from the client. */
export function cloneUrlFor(slug: RepoSlug): string {
  return `${GITHUB_CLONE_BASE}/${slug.owner}/${slug.repo}.git`;
}

export type GitHubRepoSummary = {
  slug: string;
  description: string | null;
  defaultBranch: string;
  updatedAt: string | null;
  stars: number;
};

type GitHubRepoPayload = {
  full_name?: unknown;
  description?: unknown;
  default_branch?: unknown;
  pushed_at?: unknown;
  stargazers_count?: unknown;
};

/**
 * Lists repositories the token can reach, sorted by most recently pushed.
 * With the `public_repo` scope this is public repositories only.
 */
export async function listGitHubRepos(
  token: string,
): Promise<GitHubRepoSummary[]> {
  const response = await fetch(
    `${GITHUB_API}/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      response.status === 401
        ? "GitHub rejected the token. Try reconnecting your account."
        : `GitHub returned ${response.status}. ${detail.slice(0, 120)}`,
    );
  }

  const payload = (await response.json()) as GitHubRepoPayload[];

  return payload.flatMap((repo) => {
    if (typeof repo.full_name !== "string") {
      return [];
    }
    try {
      const slug = parseRepoSlug(repo.full_name);
      return [
        {
          slug: slug.slug,
          description:
            typeof repo.description === "string" ? repo.description : null,
          defaultBranch:
            typeof repo.default_branch === "string" && repo.default_branch
              ? repo.default_branch
              : "main",
          updatedAt: typeof repo.pushed_at === "string" ? repo.pushed_at : null,
          stars:
            typeof repo.stargazers_count === "number"
              ? repo.stargazers_count
              : 0,
        },
      ];
    } catch {
      return [];
    }
  });
}

export type GitConnection = {
  repo: string;
  branch: string;
  remoteUrl: string;
  updatedAt: Date;
};

export async function getGitConnection(
  projectId: number,
): Promise<GitConnection | null> {
  const rows = await db
    .select()
    .from(gitConnections)
    .where(eq(gitConnections.projectId, projectId))
    .limit(1);

  return rows[0] ?? null;
}

export async function saveGitConnection(input: {
  projectId: number;
  repo: string;
  branch: string;
}): Promise<GitConnection> {
  const slug = parseRepoSlug(input.repo);
  const branch = parseBranch(input.branch);
  const remoteUrl = cloneUrlFor(slug);

  const [row] = await db
    .insert(gitConnections)
    .values({ projectId: input.projectId, repo: slug.slug, branch, remoteUrl })
    .onConflictDoUpdate({
      target: gitConnections.projectId,
      set: { repo: slug.slug, branch, remoteUrl, updatedAt: new Date() },
    })
    .returning();

  return row;
}

export async function clearGitConnection(projectId: number): Promise<void> {
  await db
    .delete(gitConnections)
    .where(and(eq(gitConnections.projectId, projectId)));
}
