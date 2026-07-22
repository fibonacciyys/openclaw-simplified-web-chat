import { createApp } from "vue";
import { createPinia } from "pinia";
import ProseView from "./components/prose/ProseView.vue";
import { useConnectionStore } from "./stores/connection";
import { useProseStore } from "./stores/prose";
import { useProseRunStore } from "./stores/prose-run";
import { useWorkspaceStore } from "./stores/workspace";
import "./styles/main.css";

// Standalone harness that mounts ProseView without going through App.vue's
// connection gate. Used to capture a screenshot of the canvas after the
// handle/route fix; nothing here ships to users.
const app = createApp(ProseView);
const pinia = createPinia();
app.use(pinia).mount("#app");

const connection = useConnectionStore();
connection.status = "connected";

const prose = useProseStore();
// Use the simplest example so the screenshot is small and readable.
prose.clear();
prose.addNode("session");
prose.addNode("agent");
prose.addNode("output");

const ifNode = prose.addNode("if");
if (ifNode) {
  prose.updateNodeData(ifNode.id, {
    ifDiscretion: { text: "the platform is linux", variant: "strong" },
  });
  const thenSession = prose.addToBody(ifNode.id, "session");
  if (thenSession) prose.updateNodeData(thenSession.id, { sessionPrompt: "do linux thing" });

  const elifNode = prose.addElif(ifNode.id);
  if (elifNode) {
    prose.updateNodeData(elifNode.id, {
      ifDiscretion: { text: "the platform is win32", variant: "strong" },
    });
    const elifSession = prose.addToBody(elifNode.id, "session");
    if (elifSession) prose.updateNodeData(elifSession.id, { sessionPrompt: "do win thing" });
  }

  const elseNode = prose.addElse(ifNode.id);
  if (elseNode) {
    const elseSession = prose.addToBody(elseNode.id, "session");
    if (elseSession) prose.updateNodeData(elseSession.id, { sessionPrompt: "unsupported" });
  }
}

// Suppress unused-store warnings in dev tools.
void useProseRunStore;
void useWorkspaceStore;