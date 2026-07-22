import { serializeProse, parseProse } from "./src/lib/prose-serialize.ts";
import type { ProseNodeData } from "./src/lib/prose-types.ts";

// A tiny tree mirroring the user's pattern: use -> agent(with skills) ->
// session -> if (then/elif/else) -> output. Demonstrates discretion-gated
// branching serialization.
const tree: ProseNodeData[] = [
  { id: "use1", kind: "use", parentId: null, slot: "body", order: 0, useSource: "research", useAs: "research" },
  { id: "a1", kind: "agent", parentId: null, slot: "body", order: 1, name: "analyst", agentModel: "opus", agentPrompt: "You analyze.", agentSkills: ["research"] },
  { id: "s1", kind: "session", parentId: null, slot: "body", order: 2, name: "analysis", sessionAgent: "analyst", sessionPromptOverride: "Analyze ${id}." },
  { id: "if1", kind: "if", parentId: null, slot: "body", order: 3, ifDiscretion: { text: "the incident is critical", variant: "strong" } },
  { id: "then1", kind: "session", parentId: "if1", slot: "body", order: 0, name: "verdict", sessionPrompt: "Run critical-rollout.lobster." },
  { id: "elif1", kind: "elif", parentId: null, slot: "body", order: 4, ifDiscretion: { text: "the incident is routine", variant: "strong" } },
  { id: "elifbody", kind: "session", parentId: "elif1", slot: "body", order: 0, name: "verdict", sessionPrompt: "Run routine-fix.lobster." },
  { id: "else1", kind: "else", parentId: null, slot: "body", order: 5 },
  { id: "elsebody", kind: "session", parentId: "else1", slot: "body", order: 0, sessionPrompt: "Log and close." },
  { id: "o1", kind: "output", parentId: null, slot: "body", order: 6, name: "verdict", outputExpr: "verdict" },
];

const md = serializeProse(tree);
console.log("=== serialized .prose ===");
console.log(md);

const parsed = parseProse(md);
console.log("\n=== round-trip parse: " + parsed.nodes.length + " nodes ===");
for (const n of parsed.nodes) {
  console.log(`${n.kind}  parent=${n.parentId ?? "/"} slot=${n.slot} order=${n.order}  id=${n.id}`);
}
