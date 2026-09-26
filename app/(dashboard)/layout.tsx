import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { ModeToggle } from "@/components/ModeToggle";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between gap-4 border-b px-6 py-3 text-sm">
        <div>
          <span className="font-medium">codeagent</span>
          <span className="ml-3 text-muted-foreground">
            {session.user.email}
          </span>
        </div>
        <ModeToggle />
      </header>
      {children}
    </div>
  );
}
