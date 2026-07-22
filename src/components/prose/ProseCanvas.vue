<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from "vue";
import { VueFlow, useVueFlow, type Edge as VFEdge, type Node as VFNode } from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { Controls } from "@vue-flow/controls";
import { MiniMap } from "@vue-flow/minimap";
import ProseNode from "./nodes/ProseNode.vue";
import { useProseStore } from "../../stores/prose";
import { useProseRunStore } from "../../stores/prose-run";
import { layoutProseTree } from "../../lib/prose-layout";

// Prose canvas wrapper around <VueFlow>. Unlike FlowCanvas (a free DAG with
// user-drawn edges + draggable positions), Prose is a TREE: the layout is
// computed from parentId/slot/order every render, edges express parent→child
// containment only, and dragging + connecting are disabled. The store owns
// selection; this component just feeds `selectedId` into the layout so any
// selection source (Inspector, addNode, canvas click) reflects on the canvas.
//
// `nodes`/`edges` are computed (one-way `:nodes`/`:edges` props, NOT v-model)
// because positions are derived, not user state. Vue Flow still respects the
// `selected` field on each node for visual highlight.
const store = useProseStore();
const run = useProseRunStore();
const { onNodeClick, fitView, onInit, setViewport, viewport } = useVueFlow();

// VueFlow destroys its store on component unmount (tryOnScopeDispose →
// $destroy → removed from global storage). So the viewport (pan/zoom) doesn't
// survive in the store across tab switches — on remount, a fresh store is
// created with `default-viewport = { x:0, y:0, zoom:1 }`, and content jumps
// to the top-left corner. We work around this by snapshotting the viewport in
// `onBeforeUnmount` (fires before VueFlow's scope-dispose cleanup) into this
// module-level variable, then restoring it via `setViewport` in `onInit` on
// the next mount. On the very first mount (no saved viewport), we do an
// instant `fitView({ duration: 0 })` so content is centered instead of stuck
// at top-left.
let savedViewport: { x: number; y: number; zoom: number } | null = null;

const graph = computed(() =>
  layoutProseTree(store.nodes, {
    selectedId: store.selectedNodeId,
    statusMap: run.nodeStatus,
  }),
);

// Cast through `unknown` to satisfy Vue Flow's heavy `Node`/`Edge` generic
// props without paying the TS2589 instantiation cost on every layout call.
const nodes = computed<VFNode[]>(() => graph.value.nodes as unknown as VFNode[]);
const edges = computed<VFEdge[]>(() => graph.value.edges as unknown as VFEdge[]);

onNodeClick(({ node }) => {
  store.selectNode(node.id);
});

// Snapshot the viewport right before unmount so we can restore it on remount.
// `onBeforeUnmount` fires before VueFlow's `tryOnScopeDispose → $destroy`, so
// the store (and its reactive `viewport`) is still alive at this point.
onBeforeUnmount(() => {
  const vp = viewport.value;
  if (vp) savedViewport = { x: vp.x, y: vp.y, zoom: vp.zoom };
});

// Restore the saved viewport when VueFlow initializes on remount. `onInit`
// fires after the viewport (d3-zoom) is set up — `setViewport` just sets the
// transform, doesn't need nodes to be rendered, so the restore is instant
// (no flash of top-left). On the first mount (no saved viewport), do an
// instant `fitView` (duration: 0 = no animation) to center the content.
onInit(() => {
  if (savedViewport) {
    setViewport({ x: savedViewport.x, y: savedViewport.y, zoom: savedViewport.zoom });
  } else {
    // fitView needs node dimensions; delay until nodes are rendered.
    setTimeout(() => fitView({ duration: 0 }), 50);
  }
});

// Fit the canvas to panorama ONLY when the user picks a different run (or
// "当前编辑" draft) in the left sidebar — NOT on tab switch. On tab switch
// the saved viewport is restored above, preserving the user's pan/zoom.
//
// `viewingRunId` changes when `selectRun(runId)` or `selectDraft()` replaces
// `store.nodes`. The 60ms `setTimeout` lets Vue re-render with the new nodes
// + gives VueFlow time to measure their DOM dimensions before `fitView`.
watch(
  () => run.viewingRunId,
  () => {
    setTimeout(() => {
      fitView({ padding: 0.2, duration: 200 });
    }, 60);
  },
);
</script>

<template>
  <div class="wf-canvas">
    <VueFlow
      :nodes="nodes"
      :edges="edges"
      :nodes-draggable="false"
      :nodes-connectable="false"
      :elements-selectable="true"
      :default-viewport="{ zoom: 1 }"
      :min-zoom="0.2"
      :max-zoom="2"
      class="wf-flow"
    >
      <template #node-prose="nodeProps">
        <ProseNode :data="nodeProps.data" :selected="nodeProps.selected" />
      </template>
      <Background pattern-color="#d4d4d8" :gap="20" />
      <Controls />
      <MiniMap pannable zoomable />
    </VueFlow>
  </div>
</template>
