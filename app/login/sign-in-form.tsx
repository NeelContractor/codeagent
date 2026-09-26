"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";

export function SignInForm({
  githubEnabled,
  credentialsEnabled,
}: {
  githubEnabled: boolean;
  credentialsEnabled: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleCredentials(formData: FormData) {
    setPending(true);
    setError(null);

    const res = await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirect: false,
    });

    setPending(false);

    if (res?.error) {
      setError("Invalid email or password.");
      return;
    }

    window.location.href = "/dashboard";
  }

  if (!githubEnabled && !credentialsEnabled) {
    return (
      <p className="text-sm text-muted-foreground">
        No auth provider is configured. Set AUTH_GITHUB_ID / AUTH_GITHUB_SECRET,
        or AUTH_ENABLE_CREDENTIALS=true for local dev.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {githubEnabled && (
        <button
          type="button"
          onClick={() => signIn("github", { redirectTo: "/dashboard" })}
          className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
        >
          Continue with GitHub
        </button>
      )}

      {credentialsEnabled && (
        <form action={handleCredentials} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Email
            <input
              name="email"
              type="email"
              required
              autoComplete="email"
              className="rounded-md border px-3 py-2 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Password
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="rounded-md border px-3 py-2 text-sm"
            />
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <button
            type="submit"
            disabled={pending}
            className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      )}
    </div>
  );
}
