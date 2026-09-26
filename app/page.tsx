import Link from "next/link";
import { auth } from "@/auth";
import { ModeToggle } from "@/components/ModeToggle";

const FEATURES = [
  {
    title: "A real workspace in the tab",
    body: "Every project boots a WebContainer with Node, a terminal, and a Monaco editor. Nothing is simulated, so the agent and you work in the same filesystem.",
  },
  {
    title: "An agent that uses tools",
    body: "The model reads and writes files, lists directories, and runs commands in the container. Tool calls and their output stream back and are stored, so a conversation resumes exactly where it stopped.",
  },
  {
    title: "Work that survives a reload",
    body: "Snapshot a workspace to a validated tar archive and restore it on your next visit. Chat history and tool results are kept in Postgres alongside it.",
  },
  {
    title: "Git without a git binary",
    body: "Connect GitHub, clone a public repository, and commit and push. isomorphic-git runs inside the container, and a restored project re-attaches to its remote with local changes intact.",
  },
];

const STEPS = [
  {
    step: "01",
    title: "Connect an account",
    body: "Sign in with GitHub, or with the email and password created by the seed script.",
  },
  {
    step: "02",
    title: "Pick a starting point",
    body: "Clone a public repository, or begin from a starter workspace and let the agent scaffold it.",
  },
  {
    step: "03",
    title: "Build, snapshot, push",
    body: "Work alongside the agent, snapshot when you want a restore point, and push when you are ready to share it.",
  },
];

export default async function Home() {
  const session = await auth();

  return (
    <main className="flex-1">
      <section className="border-b">
        <div className="mx-auto flex max-w-5xl flex-col gap-10 px-6 py-20 sm:py-28">
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <div className="flex items-center gap-3">
              <span className="font-semibold tracking-tight">codeagent</span>
              <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                WebContainer + isomorphic-git
              </span>
            </div>
            <ModeToggle />
          </div>

          <div className="flex max-w-3xl flex-col gap-6">
            <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
              A coding agent with a real environment behind it.
            </h1>
            <p className="max-w-2xl text-lg text-muted-foreground">
              codeagent gives every project a full Node workspace running in
              your browser, an LLM that can actually operate it, and somewhere
              for the work to live: persisted chat, restorable snapshots, and a
              real GitHub remote.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {session?.user ? (
              <>
                <Link
                  href="/dashboard"
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                >
                  Open your projects
                </Link>
                <Link
                  href="/dashboard/editor"
                  className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
                >
                  Latest project
                </Link>
              </>
            ) : (
              <>
                <Link
                  href="/login"
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                >
                  Get started
                </Link>
                <a
                  href="#how-it-works"
                  className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
                >
                  How it works
                </a>
              </>
            )}
          </div>

          {session?.user?.email && (
            <p className="text-sm text-muted-foreground">
              Signed in as {session.user.email}.
            </p>
          )}
        </div>
      </section>

      <section className="border-b">
        <div className="mx-auto grid max-w-5xl gap-10 px-6 py-16 sm:grid-cols-2">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="flex flex-col gap-2">
              <h2 className="font-medium">{feature.title}</h2>
              <p className="text-sm text-muted-foreground">{feature.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="how-it-works" className="border-b">
        <div className="mx-auto flex max-w-5xl flex-col gap-10 px-6 py-16">
          <h2 className="text-2xl font-semibold tracking-tight">
            How it works
          </h2>
          <ol className="grid gap-8 sm:grid-cols-3">
            {STEPS.map((item) => (
              <li key={item.step} className="flex flex-col gap-2">
                <span className="font-mono text-xs text-muted-foreground">
                  {item.step}
                </span>
                <h3 className="font-medium">{item.title}</h3>
                <p className="text-sm text-muted-foreground">{item.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section>
        <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-16">
          <h2 className="text-2xl font-semibold tracking-tight">
            Runs entirely in the browser
          </h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            There is no sandbox VM to provision and no container fleet to bill.
            The workspace is a WebContainer booted on demand, cross-origin
            isolated so it can run Node, with git provided by isomorphic-git
            rather than a system binary. Snapshots are validated tar archives
            and stored behind an interface that currently writes to local disk.
          </p>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Repository access is scoped to public repositories only. The OAuth
            token stays out of the clone path and is attached solely to push.
          </p>
        </div>
      </section>

      <footer className="border-t">
        <div className="mx-auto max-w-5xl px-6 py-8 text-xs text-muted-foreground">
          codeagent — Next.js, Drizzle, Auth.js, WebContainer, isomorphic-git
        </div>
      </footer>
    </main>
  );
}
