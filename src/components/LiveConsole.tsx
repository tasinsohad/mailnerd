import { useState, useRef, useEffect } from "react";
import { Terminal, Loader2, Check, Copy, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// Shared live console for any server run (Troubleshoot, Auto-heal on Domains/Jobs). One SSE stream
// keyed by a client-generated runId; the server emits console lines the fixes/checks produce.

export type ConsoleLine = { kind: "cmd" | "out" | "info" | "error"; text: string };

// Subscribe to a run's console BEFORE starting it, so no output is missed. The runId is generated
// here (client-side) precisely so the stream can exist before the server begins emitting.
export function openConsole(onLine: (fn: (prev: ConsoleLine[]) => ConsoleLine[]) => void): {
  runId: string;
  close: () => void;
} {
  const runId = globalThis.crypto?.randomUUID?.() ?? `run-${Math.random().toString(36).slice(2)}`;
  let es: EventSource | null = null;
  try {
    es = new EventSource(`/api/sse?runId=${encodeURIComponent(runId)}`);
    es.onmessage = (e) => {
      try {
        const line = JSON.parse(e.data) as ConsoleLine;
        if (line?.text) onLine((prev) => [...prev, line]);
      } catch {
        /* ignore malformed frames */
      }
    };
    // The transcript in the response is the fallback — don't surface stream hiccups.
    es.onerror = () => {};
  } catch {
    es = null;
  }
  return { runId, close: () => es?.close() };
}

// Tones for the console's own dark canvas — these can't reference the page's ink tokens, which
// invert with the theme. The instrument stays dark, so its palette is fixed to it.
const LINE_TONE: Record<ConsoleLine["kind"], string> = {
  cmd: "text-terminal-foreground", // what we ran — the instrument's signal green
  out: "text-white/85", // what the server said
  info: "text-white/50", // our own narration
  error: "text-[oklch(0.72_0.19_25)]", // a red that survives the dark canvas
};

// Flatten the console to plain text — what Copy/Download hand over.
export function consoleText(lines: ConsoleLine[]): string {
  return lines.map((l) => (l.kind === "cmd" ? `$ ${l.text}` : l.text)).join("\n");
}

// Save text to a file the user can attach or keep.
export function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Revoking straight away can cancel the download before iOS Safari has started it.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Live terminal for a run: shows each command we send and the server's output as it arrives.
export function LiveConsole({
  lines,
  running,
  filenameBase,
}: {
  lines: ConsoleLine[];
  running: boolean;
  filenameBase: string;
}) {
  const logRef = useRef<HTMLDivElement>(null);
  // Where our own auto-scroll last left the pane, so its scroll event isn't mistaken for the user.
  const autoScrollTop = useRef(0);
  const [stick, setStick] = useState(true);
  const [copied, setCopied] = useState(false);

  // Follow the tail while it streams, unless the user has scrolled up to read something. Scroll the
  // pane itself: scrollIntoView would also scroll the page, yanking it back on every new line.
  useEffect(() => {
    const el = logRef.current;
    if (!stick || !el) return;
    el.scrollTop = el.scrollHeight;
    autoScrollTop.current = el.scrollTop;
  }, [lines, stick]);

  // Works for wheel, touch and keyboard alike: scrolling up pauses, reaching the bottom resumes.
  const onLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 8) setStick(true);
    else if (el.scrollTop < autoScrollTop.current - 1) setStick(false);
  };

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(consoleText(lines));
      setCopied(true);
      toast.success(`Copied ${lines.length} line${lines.length === 1 ? "" : "s"}`);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy to clipboard");
    }
  };

  return (
    // The console is the design system's instrument (.console): dark canvas + mono, in both
    // themes. It's the one surface that is literally the machine talking.
    <div className="console overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 border-b border-white/10 px-4 py-2.5">
        <Terminal aria-hidden className="h-4 w-4 text-white/55" />
        <h3 className="font-sans text-sm font-semibold text-white/90">Console</h3>
        {running && <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin text-white/55" />}
        <span className="ml-auto font-sans text-xs tabular-nums text-white/55">
          {lines.length} line{lines.length === 1 ? "" : "s"}
        </span>
        <button
          onClick={() => setStick((s) => !s)}
          aria-pressed={stick}
          className={cn(
            "rounded px-3 py-2 font-sans text-xs transition-colors duration-150 sm:px-2 sm:py-1",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40",
            stick ? "text-terminal-foreground" : "text-white/55 hover:text-white/80",
          )}
          title={stick ? "Following new output — click to pause" : "Paused — click to follow"}
        >
          {stick ? "Following" : "Paused"}
        </button>
        <button
          onClick={copyAll}
          disabled={lines.length === 0}
          className="inline-flex items-center gap-1.5 rounded border border-white/15 px-3 py-2 sm:px-2 sm:py-1 font-sans text-xs text-white/80 transition-colors duration-150 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:pointer-events-none disabled:opacity-40"
          title="Copy the whole console"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          Copy
        </button>
        <button
          onClick={() => downloadText(`${filenameBase}-console.log`, consoleText(lines))}
          disabled={lines.length === 0}
          className="inline-flex items-center gap-1.5 rounded border border-white/15 px-3 py-2 sm:px-2 sm:py-1 font-sans text-xs text-white/80 transition-colors duration-150 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:pointer-events-none disabled:opacity-40"
          title="Download the whole console"
        >
          <Download className="h-3 w-3" />
          Download
        </button>
      </div>
      <div
        ref={logRef}
        className="max-h-[22rem] overflow-auto px-4 py-3"
        // Wheel-up pauses at once, so a fast stream can't snap the pane back before onScroll runs.
        onWheel={(e) => {
          if (e.deltaY < 0) setStick(false);
        }}
        onScroll={onLogScroll}
        role="log"
        aria-live="polite"
        aria-label="Server console output"
      >
        {lines.length === 0 ? (
          <p className="py-6 text-center text-white/40">Waiting for output…</p>
        ) : (
          <pre className="whitespace-pre-wrap break-words">
            {lines.map((l, i) => (
              <div key={i} className={LINE_TONE[l.kind]}>
                {l.kind === "cmd" ? (
                  <>
                    <span className="select-none text-white/30">$ </span>
                    {l.text}
                  </>
                ) : (
                  l.text
                )}
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  );
}
