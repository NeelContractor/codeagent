type ToolCallCardProps = {
  name: string;
  args: string;
  result: string;
  ok: boolean;
  status: "running" | "done";
};

function preview(args: string): string {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const first = Object.values(parsed)[0];

    if (typeof first === "string") {
      const flat = first.replace(/\s+/g, " ");

      return flat.length > 42 ? `${flat.slice(0, 42)}…` : flat;
    }
  } catch {
    // Fall through to the raw arguments.
  }

  const flat = args.replace(/\s+/g, " ");

  return flat.length > 42 ? `${flat.slice(0, 42)}…` : flat;
}

export function ToolCallCard({
  name,
  args,
  result,
  ok,
  status,
}: ToolCallCardProps) {
  const tone =
    status === "running"
      ? "text-muted-foreground"
      : ok
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-destructive";

  return (
    <details
      data-testid="tool-card"
      data-tool={name}
      data-ok={ok ? "true" : "false"}
      className="overflow-hidden rounded-md border bg-muted/40 text-sm"
    >
      <summary
        data-testid="tool-card-summary"
        className="flex cursor-pointer list-none items-center gap-2 px-3 py-2"
      >
        <span aria-hidden className="text-muted-foreground">
          ▸
        </span>
        <span className="font-mono font-medium">{name}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {preview(args)}
        </span>
        <span data-testid="tool-card-status" className={`text-xs ${tone}`}>
          {status === "running" ? "running…" : ok ? "ok" : "failed"}
        </span>
      </summary>

      <div className="space-y-2 border-t px-3 py-2">
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground uppercase">
            Arguments
          </p>
          <pre
            data-testid="tool-card-args"
            className="max-h-48 overflow-auto rounded bg-background p-2 font-mono text-xs whitespace-pre-wrap"
          >
            {args}
          </pre>
        </div>

        {status === "done" && (
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground uppercase">
              Result
            </p>
            <pre
              data-testid="tool-card-result"
              className="max-h-48 overflow-auto rounded bg-background p-2 font-mono text-xs whitespace-pre-wrap"
            >
              {result}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}
