// Prose editor store: owns the flat node list (parentId/slot/order tree) and
// exposes the serialized `.prose` Markdown + validation issues. Mutations
// splice the flat list.
//
// OpenProse is a tree/block program, not a DAG — there are no data-flow edges.
// Discretion (`**...**`) text lives on the node.
import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { newProseNodeId, parseProse, serializeProse, validateProse } from "../lib/prose-serialize";
import type { ProseNodeData, ProseNodeKind } from "../lib/prose-types";
import { useModelsStore } from "./models";
import { useSessionsStore } from "./sessions";

export const useProseStore = defineStore("prose", () => {
  const nodes = ref<ProseNodeData[]>([]);
  const selectedNodeId = ref<string | null>(null);

  const takenIds = computed(() => new Set(nodes.value.map((n) => n.id)));

  const prose = computed(() => serializeProse(nodes.value));
  const issues = computed(() => validateProse(nodes.value));
  const selectedNode = computed(() => nodes.value.find((n) => n.id === selectedNodeId.value) ?? null);

  // --- Mutations ---

  function nextOrder(parentId: string | null, slot: string): number {
    return nodes.value.filter((n) => (n.parentId ?? null) === parentId && n.slot === slot).length;
  }

  function addNode(kind: ProseNodeKind, opts?: { parentId?: string | null; slot?: string; afterId?: string }): ProseNodeData {
    const parentId = opts?.parentId ?? null;
    const slot = opts?.slot ?? "body";
    const id = newProseNodeId(kind, takenIds.value);
    let order: number;
    if (opts?.afterId) {
      const anchor = nodes.value.find((n) => n.id === opts.afterId);
      order = anchor ? (anchor.order ?? 0) + 1 : nextOrder(parentId, slot);
      // Shift later siblings.
      for (const n of nodes.value) {
        if ((n.parentId ?? null) === parentId && n.slot === slot && (n.order ?? 0) >= order) n.order = (n.order ?? 0) + 1;
      }
    } else {
      order = nextOrder(parentId, slot);
    }
    const node: ProseNodeData = { id, kind, parentId, slot, order };
    applyDefaults(node);
    nodes.value = [...nodes.value, node];
    selectedNodeId.value = id;
    return node;
  }

  function applyDefaults(node: ProseNodeData): void {
    switch (node.kind) {
      case "agent":
        node.name = node.id;
        // Prefer the gateway's configured default model (sessions.defaults.model
        // — the model the user actually set as default), then the first
        // catalog entry, falling back to the Prose "sonnet" alias only if
        // nothing is configured yet.
        node.agentModel = resolveDefaultModel();
        break;
      case "input":
        node.name = "value";
        node.inputPrompt = "";
        break;
      case "output":
        node.name = "result";
        node.outputExpr = "";
        break;
      case "session":
        node.sessionAgent = "";
        break;
      case "assign":
        node.name = "value";
        node.assignExpr = "";
        break;
      case "use":
        node.useSource = "";
        break;
      case "if":
      case "elif":
        node.ifDiscretion = { text: "true", variant: "strong" };
        break;
      case "choice":
        node.choiceDiscretion = { text: "the best option", variant: "strong" };
        break;
      case "option":
        node.optionLabel = "option";
        break;
      case "parallel":
        node.parallelJoin = "all";
        break;
      case "loop":
        node.loopKind = "until";
        node.loopDiscretion = { text: "done", variant: "strong" };
        break;
      case "else":
        break;
    }
  }

  /** Resolve the model id to default new agent nodes to: the configured
   *  gateway default, else the first catalog entry, else the "sonnet" alias. */
  function resolveDefaultModel(): string {
    const sessions = useSessionsStore();
    const models = useModelsStore();
    const configuredDefault = sessions.defaults?.model;
    if (configuredDefault && configuredDefault.trim()) return configuredDefault;
    const first = models.catalog[0];
    if (first) return first.alias || first.id;
    return "sonnet";
  }

  function removeNode(id: string): void {
    // Remove the node and all descendants.
    const toRemove = new Set<string>([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of nodes.value) {
        if (n.parentId && toRemove.has(n.parentId) && !toRemove.has(n.id)) {
          toRemove.add(n.id);
          changed = true;
        }
      }
    }
    // Reorder siblings of the removed root-level removal.
    const removed = nodes.value.find((n) => n.id === id);
    if (removed) {
      const parentId = removed.parentId ?? null;
      const slot = removed.slot;
      const sibs = nodes.value
        .filter((n) => (n.parentId ?? null) === parentId && n.slot === slot && n.id !== id)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      sibs.forEach((s, i) => (s.order = i));
    }
    nodes.value = nodes.value.filter((n) => !toRemove.has(n.id));
    if (selectedNodeId.value && toRemove.has(selectedNodeId.value)) selectedNodeId.value = null;
  }

  function updateNodeData(id: string, patch: Partial<ProseNodeData>): void {
    const node = nodes.value.find((n) => n.id === id);
    if (!node) return;
    Object.assign(node, patch);
    nodes.value = [...nodes.value];
  }

  // --- Helpers for control-flow constructs ---

  /** Add a statement to a group node's body slot. */
  function addToBody(groupId: string, kind: ProseNodeKind): ProseNodeData | null {
    if (!nodes.value.some((n) => n.id === groupId)) return null;
    return addNode(kind, { parentId: groupId, slot: "body" });
  }

  /** Add a parallel branch (a statement in the "branch" slot). */
  function addBranch(parallelId: string, kind: ProseNodeKind): ProseNodeData | null {
    if (!nodes.value.some((n) => n.id === parallelId)) return null;
    return addNode(kind, { parentId: parallelId, slot: "branch" });
  }

  /** Add an option to a choice node. */
  function addOption(choiceId: string): ProseNodeData | null {
    if (!nodes.value.some((n) => n.id === choiceId)) return null;
    return addNode("option", { parentId: choiceId, slot: "option" });
  }

  /**
   * Find the tail of an if/elif chain: the last consecutive `elif` sibling
   * after the given if, or the if itself if there are no elifs. Used to
   * append elif/else at the END of the chain so the sibling order stays
   * `if -> elif* -> else` on the canvas (not `if -> else -> elif`).
   */
  function chainTail(ifId: string): ProseNodeData | null {
    const anchor = nodes.value.find((n) => n.id === ifId);
    if (!anchor) return null;
    const parentId = anchor.parentId ?? null;
    const sibs = nodes.value
      .filter((n) => (n.parentId ?? null) === parentId && n.slot === anchor.slot)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const idx = sibs.findIndex((s) => s.id === ifId);
    if (idx < 0) return anchor;
    let tail = sibs[idx]!;
    for (let i = idx + 1; i < sibs.length; i++) {
      if (sibs[i]!.kind === "elif") tail = sibs[i]!;
      else break;
    }
    return tail;
  }

  /**
   * Append an elif as a chained sibling at the END of the if/elif chain
   * (after the last elif, or after the if if there are none).
   */
  function addElif(ifId: string): ProseNodeData | null {
    const anchor = nodes.value.find((n) => n.id === ifId);
    if (!anchor || (anchor.kind !== "if" && anchor.kind !== "elif")) return null;
    const tail = chainTail(ifId) ?? anchor;
    return addNode("elif", { parentId: anchor.parentId, slot: anchor.slot, afterId: tail.id });
  }
  function addElse(ifId: string): ProseNodeData | null {
    const anchor = nodes.value.find((n) => n.id === ifId);
    if (!anchor || (anchor.kind !== "if" && anchor.kind !== "elif" && anchor.kind !== "else")) return null;
    const tail = chainTail(ifId) ?? anchor;
    const parentId = anchor.parentId ?? null;
    // Only one else per chain: bail if the sibling right after the chain tail
    // is already an else.
    const sibs = nodes.value
      .filter((n) => (n.parentId ?? null) === parentId && n.slot === anchor.slot)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const tailIdx = sibs.findIndex((s) => s.id === tail.id);
    const next = tailIdx >= 0 && tailIdx + 1 < sibs.length ? sibs[tailIdx + 1]! : null;
    if (next && next.kind === "else") return null;
    return addNode("else", { parentId, slot: anchor.slot, afterId: tail.id });
  }

  function selectNode(id: string | null): void {
    selectedNodeId.value = id;
  }

  function clear(): void {
    nodes.value = [];
    selectedNodeId.value = null;
  }

  /** Replace the program with a snapshot (no re-parse). Used to restore a
   *  saved draft when switching back from viewing a past run. */
  function setNodes(next: ProseNodeData[]): void {
    nodes.value = next.map((n) => ({ ...n }));
    selectedNodeId.value = null;
  }

  function loadProse(text: string): void {
    const parsed = parseProse(text);
    nodes.value = parsed.nodes;
    selectedNodeId.value = null;
  }

  function seedExample(): void {
    clear();
    // Mirrors the user's pattern: use a skill -> define an agent that reads it
    // -> session runs it -> VM analyzes -> if **...** dynamic branch -> parallel
    // follow-up. Demonstrates discretion-gated branching (the Prose-only
    // capability Lobster cannot express).
    const use = addNode("use");
    updateNodeData(use.id, { useSource: "incident-research", useAs: "research" });

    const analyst = addNode("agent");
    updateNodeData(analyst.id, {
      name: "analyst",
      agentModel: "opus",
      agentPrompt: "You analyze incidents and recommend a severity.",
      agentSkills: ["research"],
    });

    const input = addNode("input");
    updateNodeData(input.id, { name: "incident_id", inputPrompt: "Enter the incident id" });

    const analysis = addNode("session");
    updateNodeData(analysis.id, {
      name: "analysis",
      sessionAgent: "analyst",
      sessionPromptOverride: "Analyze incident ${incident_id} and recommend a severity.",
    });

    const ifNode = addNode("if");
    updateNodeData(ifNode.id, {
      ifDiscretion: { text: "the incident is critical and needs deterministic rollout gating", variant: "strong" },
    });
    const thenSession = addToBody(ifNode.id, "session")!;
    updateNodeData(thenSession.id, {
      name: "verdict",
      sessionPrompt: "Run the critical-rollout lobster pipeline via the lobster tool.",
    });

    const elifNode = addElif(ifNode.id)!;
    updateNodeData(elifNode.id, {
      ifDiscretion: { text: "the incident is routine", variant: "strong" },
    });
    const elifSession = addToBody(elifNode.id, "session")!;
    updateNodeData(elifSession.id, {
      name: "verdict",
      sessionPrompt: "Run routine-fix.lobster via the lobster tool.",
    });

    const elseNode = addElse(ifNode.id)!;
    const elseLog = addToBody(elseNode.id, "session")!;
    updateNodeData(elseLog.id, { sessionPrompt: "Log the incident and close it." });

    const out = addNode("output");
    updateNodeData(out.id, { name: "verdict", outputExpr: "verdict" });
  }

  return {
    nodes,
    selectedNodeId,
    selectedNode,
    prose,
    issues,
    addNode,
    removeNode,
    updateNodeData,
    addToBody,
    addBranch,
    addOption,
    setNodes,
    addElif,
    addElse,
    selectNode,
    clear,
    loadProse,
    seedExample,
  };
});
