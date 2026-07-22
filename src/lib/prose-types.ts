// Internal model for the OpenProse visual editor.
//
// OpenProse is a tree/block program (Python-like INDENT/DEDENT), NOT a free
// DAG like Lobster. The editor models each statement as a node; control-flow
// constructs (if/elif/else, choice/option, parallel/branch, loop) are GROUP
// nodes that contain their body via a `parentId` + `slot` reference. The
// branch conditions are `discretion` markers (`**<natural language>**`) that
// the OpenProse VM agent evaluates semantically at run time — this is the
// key difference from Lobster's deterministic `when:` expressions.
//
// Grammar source: extensions/open-prose/skills/prose/compiler.md (lines
// 2855-2914) and prose.md (lines 355-409). Discretion: `**TEXT**` or
// `**_TEXT_**`.

export type ProseNodeKind =
  | "use"
  | "agent"
  | "input"
  | "output"
  | "session"
  | "assign"
  | "if"
  | "elif"
  | "else"
  | "choice"
  | "option"
  | "parallel"
  | "loop";

/** `**text**` (strong) or `**_text_**` (em-strong) discretion marker. */
export interface Discretion {
  text: string;
  variant: "strong" | "emstrong";
}

export interface AgentPermissions {
  read?: string[];
  write?: string[];
  execute?: string[];
  bash?: "allow" | "deny" | "prompt";
  network?: "allow" | "deny" | "prompt";
}

export interface ProseNodeData {
  id: string;
  kind: ProseNodeKind;
  /** Containing group node id, or null for root-level statements. */
  parentId: string | null;
  /** Which body slot of the parent this node belongs to (e.g. "body", "branch", "option"). */
  slot: string;
  /** Position within the parent slot (0-based). */
  order: number;

  // --- Leaf-statement fields ---

  /** use: source string (URL or handle/slug). */
  useSource?: string;
  /** use: optional `as` alias. */
  useAs?: string;

  /** agent / input / output / assign / session-binding: the bound name. */
  name?: string;

  /** agent: model (sonnet | opus | haiku). */
  agentModel?: string;
  /** agent: system prompt. */
  agentPrompt?: string;
  /** agent: persist strategy. */
  agentPersist?: string;
  /** agent: imported skill ids to assign (must be `use`d first). */
  agentSkills?: string[];
  /** agent: retry count. */
  agentRetry?: number;
  /** agent: backoff strategy. */
  agentBackoff?: string;
  /** agent: permissions block. */
  agentPermissions?: AgentPermissions;

  /** input: string prompt OR discretion (one of the two). */
  inputPrompt?: string;
  inputDiscretion?: Discretion;

  /** output: the expression to emit. */
  outputExpr?: string;

  /** assign: the expression (e.g. `session: agent` result, or a literal). */
  assignExpr?: string;

  /** session: agent reference (when `session: agentName` or `name = session: agentName`). */
  sessionAgent?: string;
  /** session: inline prompt (when `session "..."`). Mutually exclusive with sessionAgent. */
  sessionPrompt?: string;
  /** session: override prompt property. */
  sessionPromptOverride?: string;
  /** session: override model property. */
  sessionModelOverride?: string;

  // --- Control-flow (group) fields ---

  /** if / elif: the discretion condition. */
  ifDiscretion?: Discretion;
  /** choice: the dispatch discretion. */
  choiceDiscretion?: Discretion;
  /** option: the option label string. */
  optionLabel?: string;
  /** loop: until/while discretion + which keyword. */
  loopKind?: "until" | "while";
  loopDiscretion?: Discretion;
  /** loop: max iterations. */
  loopMax?: number;
  /** branch: optional binding name (`name = statement`). */
  branchName?: string;
  /** parallel: join strategy. */
  parallelJoin?: "all" | "first" | "any";
  /** parallel: on-fail policy. */
  parallelOnFail?: string;
  /** parallel: count modifier (only with `any`). */
  parallelCount?: number;
}

export type ProseValidationIssue = {
  level: "error" | "warn";
  message: string;
  nodeId?: string;
};

/** Kinds that act as group containers (have child statements in a body slot). */
export const GROUP_KINDS: ReadonlySet<ProseNodeKind> = new Set<ProseNodeKind>([
  "if",
  "elif",
  "else",
  "choice",
  "option",
  "parallel",
  "loop",
]);

export function isGroupKind(kind: ProseNodeKind): boolean {
  return GROUP_KINDS.has(kind);
}

/** The body slot name for a group kind (where its child statements live). */
export function bodySlotOf(_kind: ProseNodeKind): string {
  // All current group kinds use a single "body" slot. choice's children are
  // `option` nodes in slot "option"; parallel's children are `branch` nodes in
  // slot "branch"; but those child group nodes' own bodies are "body".
  return "body";
}

/** Kinds that may appear as direct children of each group kind. */
export function allowedChildKinds(parentKind: ProseNodeKind): readonly ProseNodeKind[] {
  switch (parentKind) {
    case "choice":
      return ["option"];
    case "parallel":
      // Parallel branches are `(name =)? statement` — any leaf or group statement.
      return [
        "use",
        "agent",
        "input",
        "output",
        "session",
        "assign",
        "if",
        "choice",
        "parallel",
        "loop",
      ];
    default:
      // if/elif/else/option/loop bodies accept any leaf or group statement
      // (elif/else are chained siblings, not children of if).
      return [
        "use",
        "agent",
        "input",
        "output",
        "session",
        "assign",
        "if",
        "elif",
        "else",
        "choice",
        "parallel",
        "loop",
      ];
  }
}
