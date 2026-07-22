// Serialize/deserialize between the editor tree (flat node list with
// parentId/slot/order) and `.prose` Markdown. OpenProse is a Python-like
// block language: each control-flow construct is `header:` + INDENT + body +
// DEDENT. Discretion markers (`**text**` / `**_text_**`) are AI-evaluated
// branch/loop conditions — the OpenProse VM agent judges them semantically at
// run time, unlike Lobster's deterministic `when:` expressions.
//
// Grammar source: extensions/open-prose/skills/prose/compiler.md (2855-2914)
// and prose.md (355-409).
import type {
  Discretion,
  ProseNodeData,
  ProseNodeKind,
  ProseValidationIssue,
} from "./prose-types";

const INDENT = "  ";

function discretionToString(d?: Discretion): string {
  if (!d || !d.text.trim()) return "**true**";
  return d.variant === "emstrong" ? `**_${d.text}_**` : `**${d.text}**`;
}

function parseDiscretionMarker(raw: string): Discretion | undefined {
  const trimmed = raw.trim();
  const em = trimmed.match(/^\*\*_(.+?)_\*\*$/s);
  if (em) return { text: em[1]!, variant: "emstrong" };
  const strong = trimmed.match(/^\*\*(.+?)\*\*$/s);
  if (strong) return { text: strong[1]!, variant: "strong" };
  return undefined;
}

/** Build a parentId -> sorted children map. Root nodes have parentId null. */
function childrenMap(nodes: ProseNodeData[]): Map<string | null, ProseNodeData[]> {
  const map = new Map<string | null, ProseNodeData[]>();
  map.set(null, []);
  for (const n of nodes) {
    const key = n.parentId ?? null;
    const list = map.get(key);
    if (list) list.push(n);
    else map.set(key, [n]);
  }
  for (const list of map.values()) {
    list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }
  return map;
}

function stripQuotes(s: string): string {
  return s.replace(/^"(.*)"$/, "$1");
}

/**
 * Serialize the editor tree to `.prose` Markdown. Group nodes recurse into
 * their "body" slot children at indent+1.
 */
export function serializeProse(nodes: ProseNodeData[]): string {
  return serializeProseWithLineMap(nodes).markdown;
}

export interface ProseLineRange {
  start: number;
  end: number;
}

/** Serialize + return a map of nodeId -> {start,end} 1-indexed line range in
 *  the markdown. Used to match state.md "Active Constructs" line ranges to
 *  editor nodes for canvas per-block coloring. */
export function serializeProseWithLineMap(nodes: ProseNodeData[]): {
  markdown: string;
  lineMap: Record<string, ProseLineRange>;
} {
  const children = childrenMap(nodes);
  const lines: string[] = [];
  const lineMap: Record<string, ProseLineRange> = {};
  for (const root of children.get(null) ?? []) {
    emitNode(root, 0, children, lines, lineMap);
  }
  return { markdown: lines.join("\n"), lineMap };
}

function emitNode(
  node: ProseNodeData,
  indent: number,
  children: Map<string | null, ProseNodeData[]>,
  out: string[],
  lineMap?: Record<string, ProseLineRange>,
): void {
  const start = out.length + 1; // 1-indexed line of this node's header
  if (lineMap) lineMap[node.id] = { start, end: start };
  const pad = INDENT.repeat(indent);
  switch (node.kind) {
    case "use":
      out.push(`${pad}use ${JSON.stringify(node.useSource ?? "")}${node.useAs ? ` as ${node.useAs}` : ""}`);
      break;
    case "agent":
      out.push(`${pad}agent ${node.name ?? "agent"}:`);
      emitAgentProps(node, indent + 1, out);
      break;
    case "input": {
      const value = node.inputDiscretion
        ? discretionToString(node.inputDiscretion)
        : JSON.stringify(node.inputPrompt ?? "");
      out.push(`${pad}input ${node.name ?? "value"}: ${value}`);
      break;
    }
    case "output":
      out.push(`${pad}output ${node.name ?? "result"} = ${node.outputExpr ?? ""}`);
      break;
    case "assign":
      out.push(`${pad}${node.name ?? "value"} = ${node.assignExpr ?? ""}`);
      break;
    case "session": {
      const prefix = node.name ? `${node.name} = ` : "";
      if (node.sessionAgent) {
        out.push(`${pad}${prefix}session: ${node.sessionAgent}`);
        emitSessionProps(node, indent + 1, out);
      } else {
        out.push(`${pad}${prefix}session ${JSON.stringify(node.sessionPrompt ?? "")}`);
        emitSessionProps(node, indent + 1, out);
      }
      break;
    }
    case "if":
      out.push(`${pad}if ${discretionToString(node.ifDiscretion)}:`);
      emitBody(node, indent, children, out, lineMap);
      break;
    case "elif":
      out.push(`${pad}elif ${discretionToString(node.ifDiscretion)}:`);
      emitBody(node, indent, children, out, lineMap);
      break;
    case "else":
      out.push(`${pad}else:`);
      emitBody(node, indent, children, out, lineMap);
      break;
    case "choice":
      out.push(`${pad}choice ${discretionToString(node.choiceDiscretion)}:`);
      for (const child of children.get(node.id) ?? []) {
        if (child.slot !== "option") continue;
        out.push(`${pad}${INDENT}option ${JSON.stringify(child.optionLabel ?? "")}:`);
        emitBody(child, indent + 1, children, out, lineMap);
      }
      break;
    case "option":
      out.push(`${pad}option ${JSON.stringify(node.optionLabel ?? "")}:`);
      emitBody(node, indent, children, out, lineMap);
      break;
    case "parallel": {
      const mods = emitParallelMods(node);
      out.push(`${pad}parallel${mods ? ` (${mods})` : ""}:`);
      for (const child of children.get(node.id) ?? []) {
        if (child.slot !== "branch") continue;
        const prefix = child.branchName ? `${child.branchName} = ` : "";
        emitBranch(child, prefix, indent + 1, children, out, lineMap);
      }
      break;
    }
    case "loop": {
      const cond =
        node.loopKind && node.loopDiscretion
          ? ` ${node.loopKind} ${discretionToString(node.loopDiscretion)}`
          : "";
      const maxMod = node.loopMax !== undefined ? ` (max: ${node.loopMax})` : "";
      out.push(`${pad}loop${cond}${maxMod}:`);
      emitBody(node, indent, children, out, lineMap);
      break;
    }
  }
  if (lineMap) lineMap[node.id]!.end = out.length;
}

function emitBranch(child: ProseNodeData, prefix: string, indent: number, children: Map<string | null, ProseNodeData[]>, out: string[], lineMap?: Record<string, ProseLineRange>): void {
  // A parallel branch is `(name =)? statement` — the child IS the statement
  // (a session/assign leaf, or a nested group like if/loop). Emit it directly
  // and prepend the optional binding name to its first line.
  const before = out.length;
  emitNode(child, indent, children, out, lineMap);
  const pad = INDENT.repeat(indent);
  if (out[before] !== undefined) {
    out[before] = `${pad}${prefix}${out[before]!.slice(pad.length)}`;
  }
}

function emitAgentProps(node: ProseNodeData, indent: number, out: string[]): void {
  const pad = INDENT.repeat(indent);
  if (node.agentModel) out.push(`${pad}model: ${node.agentModel}`);
  if (node.agentPrompt) out.push(`${pad}prompt: ${JSON.stringify(node.agentPrompt)}`);
  if (node.agentPersist) out.push(`${pad}persist: ${node.agentPersist}`);
  if (node.agentSkills?.length) {
    out.push(`${pad}skills: [${node.agentSkills.map((s) => JSON.stringify(s)).join(", ")}]`);
  }
  if (node.agentRetry !== undefined) out.push(`${pad}retry: ${node.agentRetry}`);
  if (node.agentBackoff) out.push(`${pad}backoff: ${node.agentBackoff}`);
  if (node.agentPermissions) {
    const p = node.agentPermissions;
    out.push(`${pad}permissions:`);
    const pp = INDENT.repeat(indent + 1);
    if (p.read?.length) out.push(`${pp}read: [${p.read.map((s) => JSON.stringify(s)).join(", ")}]`);
    if (p.write?.length) out.push(`${pp}write: [${p.write.map((s) => JSON.stringify(s)).join(", ")}]`);
    if (p.execute?.length) out.push(`${pp}execute: [${p.execute.map((s) => JSON.stringify(s)).join(", ")}]`);
    if (p.bash) out.push(`${pp}bash: ${p.bash}`);
    if (p.network) out.push(`${pp}network: ${p.network}`);
  }
}

function emitSessionProps(node: ProseNodeData, indent: number, out: string[]): void {
  const pad = INDENT.repeat(indent);
  if (node.sessionPromptOverride) out.push(`${pad}prompt: ${JSON.stringify(node.sessionPromptOverride)}`);
  if (node.sessionModelOverride) out.push(`${pad}model: ${node.sessionModelOverride}`);
}

function emitParallelMods(node: ProseNodeData): string {
  const mods: string[] = [];
  if (node.parallelJoin) mods.push(`"${node.parallelJoin}"`);
  if (node.parallelOnFail) mods.push(`on-fail: "${node.parallelOnFail}"`);
  if (node.parallelCount !== undefined) mods.push(`count: ${node.parallelCount}`);
  return mods.join(", ");
}

function emitBody(node: ProseNodeData, indent: number, children: Map<string | null, ProseNodeData[]>, out: string[], lineMap?: Record<string, ProseLineRange>): void {
  for (const child of children.get(node.id) ?? []) {
    if (child.slot !== "body") continue;
    emitNode(child, indent + 1, children, out, lineMap);
  }
}

// --- Parse (.prose Markdown -> tree) ---
// A lenient indentation-based parser. It builds a stack of open blocks; each
// indented line descends into the top block's body. Recognized headers:
//   use / agent: / input x: / output x = / x = / session ... / session: a
//   if D: / elif D: / else: / choice D: / option "s": / parallel (..)?: / loop ...:
// Unknown lines become `assign`-shaped raw nodes so they round-trip as text.

interface ParseFrame {
  node: ProseNodeData;
  /** slot name for children added while this frame is top. */
  slot: string;
  /** indent column this frame was opened at; popped when a line dedents past it. */
  indent: number;
}

export interface ParsedProse {
  nodes: ProseNodeData[];
  positions: Record<string, { x: number; y: number }>;
}

export function parseProse(source: string): ParsedProse {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const nodes: ProseNodeData[] = [];
  const positions: Record<string, { x: number; y: number }> = {};
  const stack: ParseFrame[] = [];
  let counter = 0;
  const newId = (): string => `n${(counter += 1)}`;

  function currentParent(): { parentId: string | null; slot: string } {
    if (stack.length === 0) return { parentId: null, slot: "body" };
    const top = stack[stack.length - 1]!;
    return { parentId: top.node.id, slot: top.slot };
  }
  function orderFor(parentId: string | null, slot: string): number {
    return nodes.filter((n) => (n.parentId ?? null) === parentId && n.slot === slot).length;
  }

  for (const raw of lines) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    const indent = countIndent(raw);
    const text = raw.trim();
    // Pop closed frames (those opened at an indent >= this line's indent).
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) {
      stack.pop();
    }
    // If the top frame is an agent/session property block, fold the line into
    // the node instead of creating a child statement.
    const top = stack[stack.length - 1];
    if (top && top.slot === "props") {
      applyAgentOrSessionProp(top.node, text);
      continue;
    }
    const parent = currentParent();
    const node = parseStatementLine(text, newId, parent.parentId, parent.slot, orderFor(parent.parentId, parent.slot));
    if (node) {
      nodes.push(node);
      positions[node.id] = { x: 80, y: nodes.length * 110 };
      const frame = openFrameFor(node);
      if (frame) stack.push({ node: frame.node, slot: frame.slot, indent });
    }
  }
  return { nodes, positions };
}

function countIndent(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n += 1;
    else break;
  }
  return n;
}

function parseStatementLine(
  text: string,
  newId: () => string,
  parentId: string | null,
  slot: string,
  order: number,
): ProseNodeData | null {
  const base: ProseNodeData = { id: newId(), kind: "use", parentId, slot, order };
  // use "..." [as name]
  let m = text.match(/^use\s+"([^"]*)"(?:\s+as\s+(\w+))?$/);
  if (m) {
    return { ...base, kind: "use", useSource: m[1], useAs: m[2] };
  }
  // agent name:
  m = text.match(/^agent\s+(\w+):$/);
  if (m) {
    return { ...base, kind: "agent", name: m[1] };
  }
  // input name: **..** | "..."
  m = text.match(/^input\s+(\w+)\s*:\s*(\*\*.+\*\*|\*\*_.+_\*\*|"[^"]*")$/);
  if (m) {
    const val = m[2]!;
    const d = parseDiscretionMarker(val);
    if (d) return { ...base, kind: "input", name: m[1], inputDiscretion: d };
    return { ...base, kind: "input", name: m[1], inputPrompt: stripQuotes(val) };
  }
  // output name = expr
  m = text.match(/^output\s+(\w+)\s*=\s*(.+)$/);
  if (m) {
    return { ...base, kind: "output", name: m[1], outputExpr: m[2] };
  }
  // if D: / elif D: / else:
  m = text.match(/^if\s+(\*\*.+\*\*|\*\*_.+_\*\*)\s*:$/);
  if (m) {
    return { ...base, kind: "if", ifDiscretion: parseDiscretionMarker(m[1]!) };
  }
  m = text.match(/^elif\s+(\*\*.+\*\*|\*\*_.+_\*\*)\s*:$/);
  if (m) {
    return { ...base, kind: "elif", ifDiscretion: parseDiscretionMarker(m[1]!) };
  }
  if (text === "else:") {
    return { ...base, kind: "else" };
  }
  // choice D:
  m = text.match(/^choice\s+(\*\*.+\*\*|\*\*_.+_\*\*)\s*:$/);
  if (m) {
    return { ...base, kind: "choice", choiceDiscretion: parseDiscretionMarker(m[1]!) };
  }
  // option "label":
  m = text.match(/^option\s+"([^"]*)"\s*:$/);
  if (m) {
    return { ...base, kind: "option", optionLabel: m[1], slot: "option" };
  }
  // parallel (mods)?: | parallel:
  m = text.match(/^parallel(?:\s*\(([^)]*)\))?\s*:$/);
  if (m) {
    const node: ProseNodeData = { ...base, kind: "parallel" };
    if (m[1]) applyParallelMods(node, m[1]);
    return node;
  }
  // loop [until|while D] [(max: N)]:
  m = text.match(/^loop(?:\s+(until|while)\s+(\*\*.+\*\*|\*\*_.+_\*\*))?(?:\s*\(max:\s*(\d+)\))?\s*:$/);
  if (m) {
    const node: ProseNodeData = { ...base, kind: "loop" };
    if (m[1] && m[2]) {
      node.loopKind = m[1] as "until" | "while";
      node.loopDiscretion = parseDiscretionMarker(m[2]!);
    }
    if (m[3]) node.loopMax = Number(m[3]);
    return node;
  }
  // session: agent | name = session: agent | session "prompt" | name = session "prompt"
  m = text.match(/^(?:(\w+)\s*=\s*)?session\s*:\s*(\w+)$/);
  if (m) {
    return { ...base, kind: "session", name: m[1], sessionAgent: m[2] };
  }
  m = text.match(/^(?:(\w+)\s*=\s*)?session\s+"([^"]*)"$/);
  if (m) {
    return { ...base, kind: "session", name: m[1], sessionPrompt: m[2] };
  }
  // assignment: name = expr
  m = text.match(/^(\w+)\s*=\s*(.+)$/);
  if (m) {
    return { ...base, kind: "assign", name: m[1], assignExpr: m[2] };
  }
  // agent properties / session properties / raw lines -> store as raw assign so
  // they round-trip (best-effort).
  return { ...base, kind: "assign", name: "__raw__", assignExpr: text };
}

function applyParallelMods(node: ProseNodeData, mods: string): void {
  // mods like: "all", on-fail: "continue", count: 3
  const joinMatch = mods.match(/^"([^"]*)"|^(all|first|any)\b/);
  if (joinMatch) {
    node.parallelJoin = (joinMatch[1] ?? joinMatch[2]) as "all" | "first" | "any";
  }
  const onFailMatch = mods.match(/on-fail:\s*"([^"]*)"/);
  if (onFailMatch) node.parallelOnFail = onFailMatch[1];
  const countMatch = mods.match(/count:\s*(\d+)/);
  if (countMatch) node.parallelCount = Number(countMatch[1]);
}

function openFrameFor(node: ProseNodeData): { node: ProseNodeData; slot: string } | null {
  // A line "opens a block" if it ends with ":" (control flow) or is an
  // agent/session header (indented properties follow).
  switch (node.kind) {
    case "agent":
    case "session":
      return { node, slot: "props" };
    case "if":
    case "elif":
    case "else":
    case "loop":
      return { node, slot: "body" };
    case "choice":
      return { node, slot: "option" };
    case "option":
      return { node, slot: "body" };
    case "parallel":
      return { node, slot: "branch" };
    default:
      return null;
  }
}

/** Fold an indented property line into an agent or session node. */
function applyAgentOrSessionProp(node: ProseNodeData, text: string): void {
  let m: RegExpMatchArray | null;
  if ((m = text.match(/^model:\s*(\w+)$/))) {
    if (node.kind === "agent") node.agentModel = m[1];
    if (node.kind === "session") node.sessionModelOverride = m[1];
    return;
  }
  if ((m = text.match(/^prompt:\s*"(.*)"$/))) {
    if (node.kind === "agent") node.agentPrompt = m[1];
    if (node.kind === "session") node.sessionPromptOverride = m[1];
    return;
  }
  if ((m = text.match(/^persist:\s*(.+)$/)) && node.kind === "agent") {
    node.agentPersist = m[1].trim();
    return;
  }
  if ((m = text.match(/^skills:\s*\[(.*)\]$/)) && node.kind === "agent") {
    node.agentSkills = (m[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^"(.*)"$/, "$1"))
      .filter(Boolean);
    return;
  }
  if ((m = text.match(/^retry:\s*(\d+)$/)) && node.kind === "agent") {
    node.agentRetry = Number(m[1]);
    return;
  }
  if ((m = text.match(/^backoff:\s*(\w+)$/)) && node.kind === "agent") {
    node.agentBackoff = m[1];
    return;
  }
}

// --- Validate ---

export function validateProse(nodes: ProseNodeData[]): ProseValidationIssue[] {
  const issues: ProseValidationIssue[] = [];
  const ids = new Set<string>();
  for (const n of nodes) {
    if (!n.id) issues.push({ level: "error", message: "node missing id", nodeId: n.id });
    if (ids.has(n.id)) issues.push({ level: "error", message: `duplicate id "${n.id}"`, nodeId: n.id });
    ids.add(n.id);
    validateNode(n, issues);
  }
  // Orphan check: every non-null parentId must exist.
  for (const n of nodes) {
    if (n.parentId && !ids.has(n.parentId)) {
      issues.push({ level: "error", message: `node "${n.id}" references missing parent "${n.parentId}"`, nodeId: n.id });
    }
  }
  return issues;
}

function validateNode(n: ProseNodeData, issues: ProseValidationIssue[]): void {
  switch (n.kind) {
    case "agent":
      if (!n.name) issues.push({ level: "error", message: `agent needs a name`, nodeId: n.id });
      if (!n.agentPrompt && !n.agentModel) {
        issues.push({ level: "warn", message: `agent "${n.name ?? n.id}" has no prompt or model`, nodeId: n.id });
      }
      break;
    case "input":
      if (!n.name) issues.push({ level: "error", message: `input needs a name`, nodeId: n.id });
      if (!n.inputPrompt && !n.inputDiscretion) {
        issues.push({ level: "error", message: `input "${n.name ?? n.id}" needs a prompt or discretion`, nodeId: n.id });
      }
      break;
    case "output":
      if (!n.name) issues.push({ level: "error", message: `output needs a name`, nodeId: n.id });
      break;
    case "session":
      if (!n.sessionAgent && !n.sessionPrompt) {
        issues.push({ level: "error", message: `session needs an agent ref or inline prompt`, nodeId: n.id });
      }
      break;
    case "assign":
      if (!n.name) issues.push({ level: "error", message: `assignment needs a name`, nodeId: n.id });
      break;
    case "use":
      if (!n.useSource) issues.push({ level: "error", message: `use needs a source`, nodeId: n.id });
      break;
    case "if":
    case "elif":
      if (!n.ifDiscretion?.text?.trim()) {
        issues.push({ level: "error", message: `${n.kind} needs a discretion condition`, nodeId: n.id });
      }
      break;
    case "choice":
      if (!n.choiceDiscretion?.text?.trim()) {
        issues.push({ level: "error", message: `choice needs a discretion condition`, nodeId: n.id });
      }
      break;
    case "option":
      if (!n.optionLabel) issues.push({ level: "warn", message: `option has no label`, nodeId: n.id });
      break;
    case "loop":
      if (n.loopKind && !n.loopDiscretion?.text?.trim()) {
        issues.push({ level: "error", message: `loop ${n.loopKind} needs a discretion condition`, nodeId: n.id });
      }
      break;
  }
}

/** Generate a unique id for a new node of the given kind. */
export function newProseNodeId(kind: ProseNodeKind, taken: Set<string>): string {
  const baseByKind: Record<ProseNodeKind, string> = {
    use: "use",
    agent: "agent",
    input: "input",
    output: "output",
    session: "session",
    assign: "var",
    if: "if",
    elif: "elif",
    else: "else",
    choice: "choice",
    option: "opt",
    parallel: "parallel",
    loop: "loop",
  };
  const base = baseByKind[kind];
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base}${n}`;
    n += 1;
  }
  return candidate;
}
