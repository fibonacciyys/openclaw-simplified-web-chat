<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useProseStore } from "../../stores/prose";
import { useModelsStore } from "../../stores/models";
import type { Discretion, ProseNodeKind } from "../../lib/prose-types";

// Per-kind editor for the selected statement. Group nodes also expose
// "add to body / branch / option" and (for if) "add elif / else" helpers so
// the user builds the tree structurally rather than by typing indentation.
const store = useProseStore();
const models = useModelsStore();
const node = computed(() => store.selectedNode);
const data = computed(() => node.value);

// Model options come from the gateway's configured catalog (models.list),
// not a hardcoded list. Prose's grammar enum is `sonnet | opus | haiku`, so
// those aliases are always offered first; catalog entries add the real
// provider models the user has configured. The emitted `model:` value uses
// the entry's alias when present (matches the Prose enum) else the model id.
const modelOptions = computed<{ value: string; label: string }[]>(() => {
  const base = [
    { value: "sonnet", label: "sonnet (alias)" },
    { value: "opus", label: "opus (alias)" },
    { value: "haiku", label: "haiku (alias)" },
  ];
  const seen = new Set(base.map((o) => o.value));
  const out = [...base];
  for (const entry of models.catalog) {
    const value = entry.alias || entry.id;
    if (seen.has(value)) continue;
    seen.add(value);
    const label = entry.name && entry.name !== entry.id
      ? `${entry.name} (${entry.id})`
      : entry.id;
    out.push({ value, label });
  }
  const current = data.value?.agentModel;
  if (current && !seen.has(current)) {
    out.push({ value: current, label: `${current} (not in catalog)` });
  }
  return out;
});

onMounted(() => {
  // Load the model catalog if not already populated (the chat view usually
  // loads it, but the Prose editor may be opened without visiting chat).
  if (models.catalog.length === 0 && !models.loading) {
    void models.loadCatalog();
  }
});

function patch(p: Partial<NonNullable<typeof data.value>>): void {
  if (data.value) store.updateNodeData(data.value.id, p);
}

function patchDiscretion(field: "ifDiscretion" | "choiceDiscretion" | "loopDiscretion" | "inputDiscretion", text: string): void {
  if (!data.value) return;
  const existing = (data.value[field] ?? {}) as Discretion;
  patch({ [field]: { ...existing, text } } as Partial<NonNullable<typeof data.value>>);
}

function addBody(kind: ProseNodeKind): void {
  if (data.value) store.addToBody(data.value.id, kind);
}
function addBranch(kind: ProseNodeKind): void {
  if (data.value) store.addBranch(data.value.id, kind);
}
function addOption(): void {
  if (data.value) store.addOption(data.value.id);
}
function addElif(): void {
  if (data.value) store.addElif(data.value.id);
}
function addElse(): void {
  if (data.value) store.addElse(data.value.id);
}
function del(): void {
  if (data.value) store.removeNode(data.value.id);
}

const skillsText = computed({
  get: () => (data.value?.agentSkills ?? []).join(", "),
  set: (val: string) =>
    patch({
      agentSkills: val.split(",").map((s) => s.trim()).filter(Boolean),
    }),
});
</script>

<template>
  <div class="prose-inspector">
    <div v-if="data" class="prose-inspector__section">
      <div class="prose-inspector__head">
        <span class="prose-inspector__title">{{ data.kind }}</span>
        <button class="btn-danger-sm" @click="del">Delete</button>
      </div>
      <div class="prose-inspector__hint">id: {{ data.id }}</div>

      <!-- use -->
      <template v-if="data.kind === 'use'">
        <label class="form-label">
          <span>source (handle/slug or URL)</span>
          <input class="input" :value="data.useSource ?? ''" @input="(e) => patch({ useSource: (e.target as HTMLInputElement).value })" />
        </label>
        <label class="form-label">
          <span>as alias (optional)</span>
          <input class="input" :value="data.useAs ?? ''" @input="(e) => patch({ useAs: (e.target as HTMLInputElement).value || undefined })" />
        </label>
      </template>

      <!-- agent -->
      <template v-if="data.kind === 'agent'">
        <label class="form-label">
          <span>name</span>
          <input class="input" :value="data.name ?? ''" @input="(e) => patch({ name: (e.target as HTMLInputElement).value })" />
        </label>
        <label class="form-label">
          <span>model</span>
          <select class="input" :value="data.agentModel ?? 'sonnet'" @change="(e) => patch({ agentModel: (e.target as HTMLSelectElement).value })">
            <option v-for="opt in modelOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </label>
        <label class="form-label">
          <span>prompt (system)</span>
          <textarea class="input form-textarea" rows="3" :value="data.agentPrompt ?? ''" @input="(e) => patch({ agentPrompt: (e.target as HTMLTextAreaElement).value })"></textarea>
        </label>
        <label class="form-label">
          <span>skills (comma-separated, must be `use`d)</span>
          <input class="input" v-model="skillsText" placeholder="research, summarizer" />
        </label>
        <label class="form-label">
          <span>persist</span>
          <input class="input" :value="data.agentPersist ?? ''" placeholder="true | project | path" @input="(e) => patch({ agentPersist: (e.target as HTMLInputElement).value || undefined })" />
        </label>
      </template>

      <!-- input -->
      <template v-if="data.kind === 'input'">
        <label class="form-label">
          <span>name</span>
          <input class="input" :value="data.name ?? ''" @input="(e) => patch({ name: (e.target as HTMLInputElement).value })" />
        </label>
        <div class="prose-edge-kind-toggle">
          <label class="form-label form-checkbox">
            <input type="radio" :checked="!data.inputDiscretion" name="inputkind" @change="() => patch({ inputDiscretion: undefined })" />
            <span>string prompt</span>
          </label>
          <label class="form-label form-checkbox">
            <input type="radio" :checked="!!data.inputDiscretion" name="inputkind" @change="() => patch({ inputDiscretion: { text: 'Proceed?', variant: 'strong' } })" />
            <span>discretion (**...**)</span>
          </label>
        </div>
        <label v-if="!data.inputDiscretion" class="form-label">
          <span>prompt</span>
          <input class="input" :value="data.inputPrompt ?? ''" @input="(e) => patch({ inputPrompt: (e.target as HTMLInputElement).value })" />
        </label>
        <label v-else class="form-label">
          <span>discretion text</span>
          <input class="input" :value="data.inputDiscretion?.text ?? ''" @input="(e) => patchDiscretion('inputDiscretion', (e.target as HTMLInputElement).value)" placeholder="Proceed?" />
        </label>
      </template>

      <!-- output / assign -->
      <template v-if="data.kind === 'output' || data.kind === 'assign'">
        <label class="form-label">
          <span>name</span>
          <input class="input" :value="data.name ?? ''" @input="(e) => patch({ name: (e.target as HTMLInputElement).value })" />
        </label>
      </template>
      <template v-if="data.kind === 'output'">
        <label class="form-label">
          <span>expression</span>
          <textarea class="input form-textarea" rows="2" :value="data.outputExpr ?? ''" @input="(e) => patch({ outputExpr: (e.target as HTMLTextAreaElement).value })"></textarea>
        </label>
      </template>
      <template v-else-if="data.kind === 'assign'">
        <label class="form-label">
          <span>expression</span>
          <textarea class="input form-textarea" rows="2" :value="data.assignExpr ?? ''" @input="(e) => patch({ assignExpr: (e.target as HTMLTextAreaElement).value })"></textarea>
        </label>
      </template>

      <!-- session -->
      <template v-if="data.kind === 'session'">
        <label class="form-label">
          <span>binding name (optional, `name = session...`)</span>
          <input class="input" :value="data.name ?? ''" @input="(e) => patch({ name: (e.target as HTMLInputElement).value || undefined })" />
        </label>
        <div class="prose-edge-kind-toggle">
          <label class="form-label form-checkbox">
            <input type="radio" :checked="!!data.sessionAgent" name="sesskind" @change="() => patch({ sessionAgent: '' })" />
            <span>session: agent</span>
          </label>
          <label class="form-label form-checkbox">
            <input type="radio" :checked="!data.sessionAgent" name="sesskind" @change="() => patch({ sessionAgent: undefined, sessionPrompt: '' })" />
            <span>session "prompt"</span>
          </label>
        </div>
        <label v-if="data.sessionAgent !== undefined" class="form-label">
          <span>agent name</span>
          <input class="input" :value="data.sessionAgent" placeholder="analyst" @input="(e) => patch({ sessionAgent: (e.target as HTMLInputElement).value })" />
        </label>
        <label v-else class="form-label">
          <span>inline prompt</span>
          <textarea class="input form-textarea" rows="2" :value="data.sessionPrompt ?? ''" @input="(e) => patch({ sessionPrompt: (e.target as HTMLTextAreaElement).value })"></textarea>
        </label>
        <label class="form-label">
          <span>prompt override (optional)</span>
          <textarea class="input form-textarea" rows="2" :value="data.sessionPromptOverride ?? ''" @input="(e) => patch({ sessionPromptOverride: (e.target as HTMLTextAreaElement).value || undefined })"></textarea>
        </label>
        <label class="form-label">
          <span>model override (optional)</span>
          <select class="input" :value="data.sessionModelOverride ?? ''" @change="(e) => patch({ sessionModelOverride: (e.target as HTMLSelectElement).value || undefined })">
            <option value="">(inherit agent model)</option>
            <option v-for="opt in modelOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </label>
      </template>

      <!-- if / elif / choice / loop: discretion conditions -->
      <template v-if="data.kind === 'if' || data.kind === 'elif'">
        <label class="form-label">
          <span>discretion (**...**) — AI-evaluated by the VM</span>
          <textarea class="input form-textarea" rows="2" :value="data.ifDiscretion?.text ?? ''" @input="(e) => patchDiscretion('ifDiscretion', (e.target as HTMLTextAreaElement).value)" placeholder="the incident is critical"></textarea>
        </label>
        <div class="prose-inspector__sub">Add to body (then-branch)</div>
        <div class="prose-toolbar__right">
          <button class="btn-secondary btn-sm" @click="addBody('session')">+ session</button>
          <button class="btn-secondary btn-sm" @click="addBody('assign')">+ assign</button>
          <button class="btn-secondary btn-sm" @click="addBody('if')">+ nested if</button>
        </div>
        <div class="prose-inspector__sub">Chain</div>
        <div class="prose-toolbar__right">
          <button class="btn-secondary btn-sm" @click="addElif">+ elif</button>
          <button class="btn-secondary btn-sm" @click="addElse">+ else</button>
        </div>
      </template>

      <template v-if="data.kind === 'else'">
        <div class="prose-inspector__sub">Add to body (else-branch)</div>
        <div class="prose-toolbar__right">
          <button class="btn-secondary btn-sm" @click="addBody('session')">+ session</button>
          <button class="btn-secondary btn-sm" @click="addBody('assign')">+ assign</button>
        </div>
      </template>

      <template v-if="data.kind === 'choice'">
        <label class="form-label">
          <span>discretion (**...**) — dispatch key</span>
          <textarea class="input form-textarea" rows="2" :value="data.choiceDiscretion?.text ?? ''" @input="(e) => patchDiscretion('choiceDiscretion', (e.target as HTMLTextAreaElement).value)" placeholder="the severity level"></textarea>
        </label>
        <button class="btn-secondary btn-sm" @click="addOption">+ option</button>
      </template>

      <template v-if="data.kind === 'option'">
        <label class="form-label">
          <span>option label</span>
          <input class="input" :value="data.optionLabel ?? ''" @input="(e) => patch({ optionLabel: (e.target as HTMLInputElement).value })" />
        </label>
        <div class="prose-inspector__sub">Add to body</div>
        <div class="prose-toolbar__right">
          <button class="btn-secondary btn-sm" @click="addBody('session')">+ session</button>
          <button class="btn-secondary btn-sm" @click="addBody('assign')">+ assign</button>
        </div>
      </template>

      <template v-if="data.kind === 'parallel'">
        <div class="prose-run__row">
          <label class="form-label">
            <span>join</span>
            <select class="input" :value="data.parallelJoin ?? 'all'" @change="(e) => patch({ parallelJoin: (e.target as HTMLSelectElement).value as 'all' | 'first' | 'any' })">
              <option value="all">all</option>
              <option value="first">first</option>
              <option value="any">any</option>
            </select>
          </label>
          <label class="form-label">
            <span>on-fail</span>
            <select class="input" :value="data.parallelOnFail ?? ''" @change="(e) => patch({ parallelOnFail: (e.target as HTMLSelectElement).value || undefined })">
              <option value="">(default)</option>
              <option value="fail-fast">fail-fast</option>
              <option value="continue">continue</option>
              <option value="ignore">ignore</option>
            </select>
          </label>
        </div>
        <div class="prose-inspector__sub">Add branch (statement)</div>
        <div class="prose-toolbar__right">
          <button class="btn-secondary btn-sm" @click="addBranch('session')">+ session</button>
          <button class="btn-secondary btn-sm" @click="addBranch('assign')">+ assign</button>
        </div>
      </template>

      <template v-if="data.kind === 'loop'">
        <div class="prose-edge-kind-toggle">
          <label class="form-label form-checkbox">
            <input type="radio" :checked="data.loopKind === 'until'" name="loopkind" @change="() => patch({ loopKind: 'until' })" />
            <span>until</span>
          </label>
          <label class="form-label form-checkbox">
            <input type="radio" :checked="data.loopKind === 'while'" name="loopkind" @change="() => patch({ loopKind: 'while' })" />
            <span>while</span>
          </label>
        </div>
        <label class="form-label">
          <span>discretion (**...**) — AI-evaluated termination</span>
          <textarea class="input form-textarea" rows="2" :value="data.loopDiscretion?.text ?? ''" @input="(e) => patchDiscretion('loopDiscretion', (e.target as HTMLTextAreaElement).value)" placeholder="the code is bug-free"></textarea>
        </label>
        <label class="form-label">
          <span>max iterations (optional)</span>
          <input class="input" type="number" min="1" :value="data.loopMax ?? ''" @input="(e) => patch({ loopMax: (e.target as HTMLInputElement).valueAsNumber || undefined })" />
        </label>
        <div class="prose-inspector__sub">Add to body</div>
        <div class="prose-toolbar__right">
          <button class="btn-secondary btn-sm" @click="addBody('session')">+ session</button>
          <button class="btn-secondary btn-sm" @click="addBody('assign')">+ assign</button>
        </div>
      </template>
    </div>

    <div v-else class="prose-inspector__empty">
      Select a node to edit. Use the toolbar to add root statements; use a group node's "+ session / + elif / + option" buttons to build its body/branches.
    </div>
  </div>
</template>
