<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import {
  monaco,
  registerTeaseScriptLanguage,
  watchProject,
  type ProjectFileView,
} from "../../monaco.js";
import { sampleProject } from "./sample-project.js";

const container = ref<HTMLElement | null>(null);
const files = shallowRef<readonly ProjectFileView[]>([]);
const activePath = ref(sampleProject[0]!.path);
const ready = ref(false);
const diagnostics = computed(() => files.value.reduce((sum, file) => sum + file.markers.length, 0));
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let models: { readonly path: string; readonly model: monaco.editor.ITextModel }[] = [];
let listener: monaco.IDisposable | null = null;

onMounted(() => {
  registerTeaseScriptLanguage();
  models = sampleProject.map(({ path, text }) => ({
    path,
    model: monaco.editor.createModel(text, "teasescript", monaco.Uri.parse(`file:///${path}`)),
  }));
  editor = monaco.editor.create(container.value!, {
    model: models[0]!.model,
    language: "teasescript",
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 15,
    padding: { top: 16 },
  });
  listener = watchProject(models, (overview) => {
    files.value = overview;
  });
  ready.value = true;
});
onBeforeUnmount(() => {
  listener?.dispose();
  editor?.dispose();
  for (const { model } of models) model.dispose();
});

function openFile(path: string): void {
  const model = models.find((file) => file.path === path)?.model;
  if (model === undefined || editor === null) return;
  activePath.value = path;
  editor.setModel(model);
  editor.focus();
}

function tagLabel(tag: { readonly name: string; readonly value: number | null }): string {
  return tag.value === null ? tag.name : `${tag.name}: ${tag.value}`;
}
</script>

<template>
  <main>
    <header>
      <div>
        <p class="eyebrow">TeaseScript</p>
        <h1>Browser editor</h1>
        <p class="subtle">A focused Monaco surface for the implemented interaction language.</p>
      </div>
      <span class="status">{{ diagnostics }} diagnostics</span>
    </header>
    <div class="workspace">
      <nav class="files" aria-label="Project files">
        <ul>
          <li v-for="file in files" :key="file.path" :data-file-path="file.path">
            <button
              type="button"
              :aria-current="file.path === activePath ? 'true' : undefined"
              @click="openFile(file.path)"
            >
              <span class="file-title">{{ file.header?.title ?? file.path }}</span>
              <span class="file-path">{{ file.path }}</span>
              <span v-if="file.header?.author" class="file-author">by {{ file.header.author }}</span>
              <span v-if="file.header?.description" class="file-description">
                {{ file.header.description }}
              </span>
              <span v-if="file.header?.tags.length" class="file-tags">
                <span v-for="tag in file.header.tags" :key="tag.name" class="tag">
                  {{ tagLabel(tag) }}
                </span>
              </span>
              <span v-if="file.markers.length > 0" class="file-problems">
                {{ file.markers.length }} diagnostics
              </span>
            </button>
          </li>
        </ul>
      </nav>
      <section
        ref="container"
        class="editor"
        aria-label="TeaseScript source editor"
        :data-monaco-ready="String(ready)"
      />
    </div>
  </main>
</template>
