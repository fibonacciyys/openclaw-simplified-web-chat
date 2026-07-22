// Auto-layout the OpenProse tree (flat parentId/slot/order node list) into
// Vue Flow nodes + edges. Prose is a TREE, not a DAG — edges express parent→
// child containment only, never data flow. Positions are recomputed every
// render from the tree shape; they are NOT persisted on ProseNodeData (which
// would muddy the tree model and drift against the serialized `.prose`
// Markdown). The canvas disables dragging so user edits cannot fight the
// computed layout.
//
// Layout rules:
//  - Root-level statements stack vertically top→bottom in source order (this
//    is Prose's sequential execution flow).
//  - Group nodes (if/elif/else/option/loop) lay their "body" children out in
//    a sub-column to the RIGHT of the parent (indent = containment).
//  - `parallel` lays its "branch" children out SIDE-BY-SIDE under the parent
//    to express concurrency (horizontal fan-out).
//  - `choice` lays its "option" children out SIDE-BY-SIDE under the parent
//    to express alternative dispatch.
//  - Sibling if/elif/else are NOT connected by edges (they are flat siblings
//    in source, not parent/child); they just stack visually so the chain
//    reads top-to-bottom.
import type { ProseNodeData, ProseNodeKind } from "./prose-types";
import type { ProseNodeStatus } from "./prose-state-parse";

// Tuning constants. NODE_HEIGHT is an estimate — Vue Flow does not measure.
const NODE_WIDTH = 200;
const NODE_HEIGHT = 64;
const GAP_Y = 28;
const INDENT_X = 240;
const FAN_GAP_X = 280;

export interface ProseLayoutNodeData {
  kind: ProseNodeKind;
  /** Back-reference to the source ProseNodeData so the renderer can read any
   *  field without re-fetching from the store. */
  prose: ProseNodeData;
  status: ProseNodeStatus;
}

export interface ProseLayoutNode {
  id: string;
  type: "prose";
  position: { x: number; y: number };
  data: ProseLayoutNodeData;
  selected?: boolean;
  draggable?: boolean;
  connectable?: boolean;
}

export type ProseEdgeSlot = "body" | "branch" | "option";

export interface ProseLayoutEdge {
  id: string;
  source: string;
  target: string;
  /** Containment slot the edge represents; drives edge CSS class. */
  slot: ProseEdgeSlot;
  class?: string;
  type?: string;
  animated?: boolean;
}

export interface ProseLayoutGraph {
  nodes: ProseLayoutNode[];
  edges: ProseLayoutEdge[];
}

export interface ProseLayoutOptions {
  selectedId: string | null;
  statusMap: Record<string, ProseNodeStatus>;
}

interface SubtreeSize {
  width: number;
  height: number;
}

/** Build a parentId -> children map, sorted by (slot, order). */
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
    list.sort((a, b) => {
      // Sort by slot first (body < branch < option) then by order within slot.
      const sa = slotRank(a.slot);
      const sb = slotRank(b.slot);
      if (sa !== sb) return sa - sb;
      return (a.order ?? 0) - (b.order ?? 0);
    });
  }
  return map;
}

function slotRank(slot: string): number {
  if (slot === "body") return 0;
  if (slot === "branch") return 1;
  if (slot === "option") return 2;
  return 3;
}

/**
 * Lay out the OpenProse tree for Vue Flow. Pure function; safe to call inside
 * a Vue `computed`. Returns fresh arrays every call so reactivity propagates.
 */
export function layoutProseTree(nodes: ProseNodeData[], opts: ProseLayoutOptions): ProseLayoutGraph {
  const children = childrenMap(nodes);
  const outNodes: ProseLayoutNode[] = [];
  const outEdges: ProseLayoutEdge[] = [];

  // Walk root-level statements in source order, stacking them vertically.
  let yCursor = 0;
  let maxWidth = 0;
  for (const root of children.get(null) ?? []) {
    const size = layoutSubtree(root, 0, yCursor, children, opts, outNodes, outEdges);
    yCursor += size.height + GAP_Y;
    if (size.width > maxWidth) maxWidth = size.width;
  }

  // Avoid an empty graph (zero nodes) producing a 0x0 viewport — Vue Flow
  // handles it, but explicit fallback helps fit-view-on-init land somewhere
  // sensible.
  void maxWidth;
  return { nodes: outNodes, edges: outEdges };
}

/**
 * Recursively lay out a subtree rooted at `node`, placing the node at (x, y)
 * and its children below/right of it. Writes positions into `outNodes` and
 * containment edges into `outEdges`. Returns the bounding box of the laid-out
 * subtree so the caller can advance its cursor.
 */
function layoutSubtree(
  node: ProseNodeData,
  x: number,
  y: number,
  children: Map<string | null, ProseNodeData[]>,
  opts: ProseLayoutOptions,
  outNodes: ProseLayoutNode[],
  outEdges: ProseLayoutEdge[],
): SubtreeSize {
  outNodes.push({
    id: node.id,
    type: "prose",
    position: { x, y },
    data: {
      kind: node.kind,
      prose: node,
      status: opts.statusMap[node.id] ?? "idle",
    },
    selected: node.id === opts.selectedId,
    draggable: false,
    connectable: false,
  });

  const kids = children.get(node.id) ?? [];

  // Group body children stack vertically under + indented right of parent.
  // Parallel branch children fan out horizontally. Choice option children fan
  // out horizontally. A node can only have one slot populated at a time in
  // valid Prose, but we handle all three defensively.
  const bodyKids = kids.filter((k) => k.slot === "body");
  const branchKids = kids.filter((k) => k.slot === "branch");
  const optionKids = kids.filter((k) => k.slot === "option");

  let subtreeHeight = NODE_HEIGHT;
  let subtreeWidth = NODE_WIDTH;

  if (bodyKids.length > 0) {
    // Vertical stack, indented right of the parent.
    let cy = y + NODE_HEIGHT + GAP_Y;
    const cx = x + INDENT_X;
    for (const child of bodyKids) {
      pushEdge(outEdges, node.id, child.id, "body");
      const size = layoutSubtree(child, cx, cy, children, opts, outNodes, outEdges);
      cy += size.height + GAP_Y;
      if (cx + size.width > x + subtreeWidth) subtreeWidth = cx + size.width - x;
    }
    subtreeHeight = Math.max(subtreeHeight, cy - y);
  }

  if (branchKids.length > 0) {
    // Horizontal fan-out (parallel = concurrency).
    const cx0 = x + INDENT_X / 2;
    let cx = cx0;
    let fanMaxH = 0;
    const cy = y + NODE_HEIGHT + GAP_Y;
    for (const child of branchKids) {
      pushEdge(outEdges, node.id, child.id, "branch");
      const size = layoutSubtree(child, cx, cy, children, opts, outNodes, outEdges);
      cx += size.width + FAN_GAP_X;
      if (size.height > fanMaxH) fanMaxH = size.height;
    }
    const fanWidth = cx - cx0 - FAN_GAP_X;
    if (x + INDENT_X / 2 + fanWidth > x + subtreeWidth) {
      subtreeWidth = INDENT_X / 2 + fanWidth;
    }
    subtreeHeight = Math.max(subtreeHeight, NODE_HEIGHT + GAP_Y + fanMaxH);
  }

  if (optionKids.length > 0) {
    // Horizontal fan-out (choice = alternatives).
    const cx0 = x + INDENT_X / 2;
    let cx = cx0;
    let fanMaxH = 0;
    const cy = y + NODE_HEIGHT + GAP_Y;
    for (const child of optionKids) {
      pushEdge(outEdges, node.id, child.id, "option");
      const size = layoutSubtree(child, cx, cy, children, opts, outNodes, outEdges);
      cx += size.width + FAN_GAP_X;
      if (size.height > fanMaxH) fanMaxH = size.height;
    }
    const fanWidth = cx - cx0 - FAN_GAP_X;
    if (x + INDENT_X / 2 + fanWidth > x + subtreeWidth) {
      subtreeWidth = INDENT_X / 2 + fanWidth;
    }
    subtreeHeight = Math.max(subtreeHeight, NODE_HEIGHT + GAP_Y + fanMaxH);
  }

  return { width: subtreeWidth, height: subtreeHeight };
}

function pushEdge(out: ProseLayoutEdge[], source: string, target: string, slot: ProseEdgeSlot): void {
  out.push({
    id: `pe-${source}-${target}`,
    source,
    target,
    slot,
    class: `prose-edge prose-edge--${slot}`,
    type: "default",
    animated: false,
  });
}
