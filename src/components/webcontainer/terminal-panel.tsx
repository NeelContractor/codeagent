"use client";

import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { useWebContainer } from "./webcontainer-provider";

export function TerminalPanel() {
  const { wc, status } = useWebContainer();
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<
    "idle" | "starting" | "running" | "exited"
  >("idle");

  useEffect(() => {
    const host = hostRef.current;
    const instance = wc;

    if (!instance || status !== "ready" || !host) {
      return;
    }

    let disposed = false;
    let teardown: (() => void) | undefined;

    const start = async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);

      if (disposed || !hostRef.current) {
        return;
      }

      setState("starting");

      const term = new Terminal({
        convertEol: true,
        cursorBlink: true,
        fontSize: 12,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        theme: {
          background: "#0b0b0d",
          foreground: "#e6e6e6",
          cursor: "#e6e6e6",
        },
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(hostRef.current);
      fitAddon.fit();

      const shell = await instance.spawn("jsh", {
        terminal: { cols: term.cols, rows: term.rows },
      });

      if (disposed) {
        shell.kill();
        return;
      }

      setState("running");

      const writer = shell.input.getWriter();
      const dataSubscription = term.onData((data) => {
        void writer.write(data);
      });

      void (async () => {
        const reader = shell.output.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            term.write(value);
          }
        } catch {
          // Stream torn down because the process was killed.
        }
      })();

      const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
        shell.resize({ cols: term.cols, rows: term.rows });
      });
      resizeObserver.observe(hostRef.current);

      void shell.exit.then((code) => {
        if (!disposed) {
          setState("exited");
          term.writeln(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m`);
        }
      });

      teardown = () => {
        resizeObserver.disconnect();
        dataSubscription.dispose();
        void writer.releaseLock();
        shell.kill();
        term.dispose();
      };
    };

    void start();

    void start();

    return () => {
      disposed = true;
      teardown?.();
    };
  }, [wc, status]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0b0b0d]">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        <span>Terminal — jsh</span>
        <span data-testid="terminal-state">{state}</span>
      </div>
      <div
        ref={hostRef}
        data-testid="terminal-host"
        className="min-h-0 flex-1 p-1"
      />
    </div>
  );
}
