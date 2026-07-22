// Lenient parser for OpenProse `state.md` (the per-run execution-state file the
// VM writes under .prose/runs/<id>/state.md after each statement — see
// extensions/open-prose/skills/prose/state/filesystem.md:100-170). Extracts the
// run metadata, the "Active Constructs" section (per-block status), and the
// `<-- EXECUTING` current-position marker for display in the Runs panel.
//
// The parser is intentionally tolerant: it scans key:value headers and
// `### Title (lines X-Y)` + bullet items, and degrades to "raw text" display
// if the format drifts from the documented shape.

export interface ProseConstructStatus {
  title: string;
  lines?: string;
  items: { label: string; status: string }[];
}

export interface ProseRunState {
  runId?: string;
  program?: string;
  started?: string;
  updated?: string;
  constructs: ProseConstructStatus[];
  /** The trace line carrying the `<-- EXECUTING` marker (trimmed), if any. */
  executingMarker?: string;
  raw: string;
}

export function parseStateMd(text: string): ProseRunState {
  const lines = text.split(/\r?\n/);
  const result: ProseRunState = { constructs: [], raw: text };

  // Header: `key: value` lines at the top, before any `## ` section.
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("# ") || line.trim() === "") continue;
    if (line.startsWith("## ")) break;
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m) {
      const key = m[1]!.toLowerCase();
      const value = m[2]!.trim();
      if (key === "run") result.runId = value;
      else if (key === "program") result.program = value;
      else if (key === "started") result.started = value;
      else if (key === "updated") result.updated = value;
    }
  }

  // Trace: look for the `<-- EXECUTING` marker (anywhere in the file).
  for (const line of lines) {
    if (line.includes("<-- EXECUTING")) {
      result.executingMarker = line.trim();
      break;
    }
  }

  // Active Constructs: the `## Active Constructs` section.
  let sectionStart = -1;
  for (let j = 0; j < lines.length; j++) {
    if (lines[j]!.trim() === "## Active Constructs") {
      sectionStart = j;
      break;
    }
  }
  if (sectionStart >= 0) {
    let current: ProseConstructStatus | null = null;
    for (let j = sectionStart + 1; j < lines.length; j++) {
      const line = lines[j]!;
      const trimmed = line.trim();
      if (trimmed.startsWith("## ")) break; // next top-level section
      const header = trimmed.match(/^###\s+(.+?)(?:\s+\(lines\s+([0-9-]+)\))?$/);
      if (header) {
        current = { title: header[1]!.trim(), lines: header[2], items: [] };
        result.constructs.push(current);
        continue;
      }
      const bullet = trimmed.match(/^-\s+(.+)$/);
      if (bullet && current) {
        // "- a: complete" or "- status: not yet entered" or "- iteration: 0/3"
        const parts = bullet[1]!.split(/:\s*(.+)/);
        if (parts.length >= 2) {
          current.items.push({ label: parts[0]!.trim(), status: parts[1]!.trim() });
        } else {
          current.items.push({ label: bullet[1]!.trim(), status: "" });
        }
      }
    }
  }

  return result;
}

/** Summarize a parsed run state into a single short status line for the list. */
export function summarizeRunState(state: ProseRunState | null): string {
  if (!state) return "(no state)";
  if (state.executingMarker) {
    // The marker line is `... # <-- EXECUTING`; take the statement text before
    // the `#` comment so the summary reads as the executing statement.
    const head = state.executingMarker.split("#")[0]!.trim();
    return head ? `executing: ${head.slice(0, 80)}` : "executing";
  }
  const allDone = state.constructs.length > 0 && state.constructs.every((c) => c.items.every((it) => /complete|done/i.test(it.status)));
  if (allDone) return "complete";
  return state.updated ? `updated ${state.updated}` : "idle";
}

export type ProseNodeStatus = "idle" | "running" | "done";

/**
 * Map a parsed state.md to per-node statuses for canvas coloring. Combines:
 *  - "Active Constructs" line ranges (a node whose header line falls in a
 *    construct's range inherits that construct's aggregate status)
 *  - the `<-- EXECUTING` marker line (the node at that line = running; nodes
 *    before it = done)
 *
 * `lineMap`/`markdown` come from serializeProseWithLineMap on the SAME program
 * the VM ran (the run's program.prose, loaded into the editor). Best-effort —
 * the marker is matched by statement-text prefix, which is stable across the
 * program and its state.md trace rendering.
 */
export function mapStateToNodeStatus(
  state: ProseRunState | null,
  lineMap: Record<string, { start: number; end: number }>,
  markdown: string,
): Record<string, ProseNodeStatus> {
  const status: Record<string, ProseNodeStatus> = {};
  for (const id of Object.keys(lineMap)) status[id] = "idle";
  if (!state) return status;

  // Constructs: a node whose header line is inside a construct's range
  // inherits the construct's aggregate status.
  for (const c of state.constructs) {
    if (!c.lines) continue;
    const parts = c.lines.split("-").map((n) => Number(n));
    const start = parts[0] ?? 0;
    const end = parts[1] ?? start;
    const aggregate: ProseNodeStatus = c.items.some((it) => /executing|running/i.test(it.status))
      ? "running"
      : c.items.length > 0 && c.items.every((it) => /complete|done/i.test(it.status))
        ? "done"
        : "idle";
    for (const [id, range] of Object.entries(lineMap)) {
      if (range.start >= start && range.start <= end) status[id] = aggregate;
    }
  }

  // Executing marker: locate the line in the serialized program whose trimmed
  // text starts with the marker's statement text; that node = running, and all
  // nodes before it = done (coarse progress).
  if (state.executingMarker) {
    const markerText = state.executingMarker.split("#")[0]!.trim().slice(0, 24);
    if (markerText) {
      const lines = markdown.split("\n");
      let execLine = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.trim().startsWith(markerText)) {
          execLine = i + 1;
          break;
        }
      }
      if (execLine > 0) {
        for (const [id, range] of Object.entries(lineMap)) {
          if (range.start < execLine) status[id] = "done";
          if (range.start <= execLine && execLine <= (range.end || range.start)) status[id] = "running";
        }
      }
    }
  }

  return status;
}
