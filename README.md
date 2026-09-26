# codeagent

A cloud coding agent that runs a real development environment in the browser.
Each project gets a [WebContainer](https://webcontainers.io) with Node, a
terminal, and a Monaco editor, plus a chat panel wired to an LLM that can read
files, write files, list directories, and run commands in that container.

Projects persist across reloads: chat history and tool calls are stored in
Postgres, and the workspace can be snapshotted to a tar archive and restored
later. Projects can also be bound to a public GitHub repository, cloned into
the container, and pushed back with a commit.

## Features

- **In-browser workspace** — WebContainer with Node, xterm terminal, and Monaco
  editor. No `git` binary is needed; git is provided by `isomorphic-git`.
- **Agent chat with tools** — the model can `read_file`, `write_file`,
  `list_dir`, and `run_command`. Tool calls and their results stream back and
  are persisted, so a conversation can be resumed exactly where it stopped.
- **Project snapshots** — export the workspace to a validated tar archive
  (32 MB cap, path-traversal and symlink guards) and restore it on the next
  visit. Repeated saves upsert a single snapshot per project.
- **GitHub integration** — connect an OAuth account, clone a public repository,
  and commit + push. Repositories are re-attached automatically after a
  snapshot restore, with restored files kept as local changes.
- **Resizable layout** — file tree, editor, terminal, and chat in
  react-resizable-panels.

## Requirements

- [Bun](https://bun.sh) 1.4+ (the repo pins `bun@1.4.0`)
- [Docker](https://docs.docker.com/get-docker/) with Compose, for Postgres
- Node.js is *not* required on the host — it runs inside the WebContainer

## Setup

```bash
bun install                 # also copies Monaco assets into public/monaco
cp .env.example .env        # then edit .env (see below)
bun run db:up               # start Postgres in Docker
bun run db:migrate          # apply migrations
bun run db:seed             # optional: create a dev login
bun run dev                 # http://localhost:3000
```

`.env` is read by both Next.js and `docker compose`, so the Postgres values
there drive the container *and* the app. Keep `POSTGRES_PORT` and the port in
`DATABASE_URL` in sync. Bun loads `.env` automatically, so `bun run db:migrate`
works without exporting anything.

### Environment

| Variable | Purpose |
| --- | --- |
| `POSTGRES_PORT` / `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Compose service configuration |
| `DATABASE_URL` | Connection string for the app and drizzle-kit |
| `SNAPSHOT_DIR` | Where snapshots are written. Defaults to `./data/snapshots` |
| `AUTH_SECRET` | Auth.js signing secret. `openssl rand -base64 32` |
| `AUTH_URL` | Public origin, e.g. `http://localhost:3000` |
| `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` | GitHub OAuth app. Enables the Git panel |
| `AUTH_ENABLE_CREDENTIALS` | Must be exactly `"true"` to offer email/password sign-in |
| `SEED_NAME` / `SEED_EMAIL` / `SEED_PASSWORD` | Credentials created by `db:seed` |
| `LLM_API_KEY` | Groq API key. Chat returns an error when unset |
| `LLM_MODEL` | Defaults to `llama-3.3-70b-versatile` |

`bun run db:seed` creates a user with a bcrypt-hashed password that you can use
at `/login` when `AUTH_ENABLE_CREDENTIALS=true`. OAuth users have no password
hash and cannot use that form.

### GitHub setup

Create an OAuth app at <https://github.com/settings/developers> with the
callback URL `http://localhost:3000/api/auth/callback/github`, then set
`AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET`.

The provider requests `read:user user:email public_repo`. `public_repo` is the
narrowest scope that still allows pushing, and it grants **no** access to
private repositories. Anyone who signed in before this scope was added must
re-authorize before push will work.

## Scripts

| Command | Description |
| --- | --- |
| `bun run dev` | Development server on port 3000 |
| `bun run build` / `bun run start` | Production build and server |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` / `lint:fix` | Biome |
| `bun run db:up` / `db:down` / `db:logs` / `db:ps` | Postgres lifecycle |
| `bun run db:generate` | Generate a migration from `src/db/schema.ts` |
| `bun run db:migrate` | Apply migrations |
| `bun run db:seed` | Create or update the seed user |
| `bun run db:studio` | Drizzle Studio |
| `bun run monaco:assets` | Re-copy Monaco assets into `public/monaco` |

## How it works

### Routes

| Route | Purpose |
| --- | --- |
| `/` | Landing page |
| `/login` | Sign in (GitHub and/or email) |
| `/dashboard` | Project list with message and snapshot counts |
| `/dashboard/editor/[projectId]` | Workspace, chat, snapshots, and git |
| `/api/chat` | Streaming LLM endpoint with tool-calling |
| `/api/projects/[id]/snapshot` | `GET` latest, `POST` a tar body |
| `/api/projects/[id]/messages` | Persisted chat history |
| `/api/projects/[id]/git` | `GET` / `PUT` / `DELETE` repository binding |
| `/api/github/repos` | Repositories reachable with the session token |

### Snapshots

`wc.export()` produces a `FileSystemTree`, which is turned into a tar archive
by `src/lib/tar.ts`. Archives are validated on the way in and out: absolute
paths, `..` traversal, and symlinks are rejected, and the 32 MB cap is enforced
from the `X-Tar-Count` header the client sends.

Storage sits behind a small interface in `src/lib/storage.ts` that currently has
one implementation — local disk under `SNAPSHOT_DIR`. Keys are derived from the
project id (`project-123.tar`), never from request input.

`node_modules`, `.git`, and `.cache` are excluded from snapshots. The file tree
hides the same three directories, so what you see in the editor is what gets
saved. The practical consequence is that a restored project has no `.git`,
which the git integration handles by re-fetching the metadata (see below).

### Git without a `git` binary

The WebContainer has no `git` executable, and its `wc.fs` binding does not
implement `stat`/`lstat`, which `isomorphic-git` requires. So every git
operation runs as a spawned `node` process inside the container using the real
`fs` module and `isomorphic-git/http/node`, its bundled Node HTTP client. The
runner source lives in `src/lib/git/container-git.ts` and is written into
`node_modules/.cache/` at call time.

`isomorphic-git` is installed into the container on demand (about 11 seconds)
because the workspace is ephemeral and `node_modules` does not survive a reload.
Projects that never use git never pay this cost: the panel only shells out
after finding a `.git` directory.

The OAuth token reaches the container through `spawn`'s `env`, never through
command arguments or logs, and is attached **only** to `push` — cloning a
public repository needs no credentials, so the token is not handed to the remote
on reads.

Two details worth knowing:

- **Commit and push report separately.** If the commit lands but the push
  fails, the UI says so rather than reporting a bare failure, and pressing
  Push again detects the unpushed commits and retries. Otherwise the work would
  look lost while sitting in the container.
- **Restore re-attaches rather than re-clones.** Since `.git` is excluded from
  snapshots, a restored project gets a fresh clone with `noCheckout` whose
  `.git` is moved into place. The restored files are left untouched and show up
  as local changes against the remote HEAD, ready to be pushed.

The clone URL is always constructed server-side from a validated `owner/repo`
slug and is never accepted from the client, so the token cannot be pointed at an
attacker-controlled host.

### WebContainer requirements

`next.config.ts` sets `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` on every route. WebContainers
require cross-origin isolation; without these headers the editor will not boot.
Any reverse proxy in front of the app must preserve them.

Monaco is loaded from `public/monaco`, which `scripts/copy-monaco.mjs` populates
on `postinstall` (also available as `bun run monaco:assets`). The directory is
gitignored.

## Layout

`@/*` resolves to `src/*`.

```
app/
  page.tsx               Landing page
  login/                 Sign-in page and form
  (dashboard)/           Authenticated routes: project list and editor
  api/                   chat, snapshots, messages, git, GitHub repos
src/
  auth.ts                Auth.js config: GitHub + credentials providers
  components/
    chat/                Chat panel
    webcontainer/        Provider, editor, terminal, snapshot, git panel
    ui/                  shadcn/ui primitives
  db/                    Drizzle schema, client, seed
  lib/                   GitHub, tar, storage, chat tools, git runner
  types/                 Session type augmentation
drizzle/                 Generated SQL migrations
data/snapshots/          Local snapshot storage (gitignored)
```

`components/` and `lib/` in the repo root are leftover shadcn scaffolding and
are not imported by anything.

## Known limitations

- The 18 Biome errors in `src/components/ui/` are pre-existing shadcn vendor
  files and have not been cleaned up.
- Private repositories are not supported by design.
- The git panel requires a GitHub OAuth token; without one it is hidden.
