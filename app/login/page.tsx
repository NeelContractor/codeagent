import { redirect } from "next/navigation";
import { auth, credentialsEnabled, githubEnabled } from "@/auth";
import { ModeToggle } from "@/components/ModeToggle";
import { SignInForm } from "./sign-in-form";

export default async function LoginPage() {
  const session = await auth();

  if (session?.user) {
    redirect("/dashboard");
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center p-6">
      <div className="absolute top-4 right-4">
        <ModeToggle />
      </div>
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-semibold">Sign in to codeagent</h1>
          <p className="text-sm text-muted-foreground">
            Continue to your projects.
          </p>
        </div>
        <SignInForm
          githubEnabled={githubEnabled}
          credentialsEnabled={credentialsEnabled}
        />
      </div>
    </main>
  );
}
