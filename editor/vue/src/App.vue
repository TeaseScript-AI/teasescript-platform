<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { monaco, registerTeaseScriptLanguage, watchDiagnostics } from "../../monaco.js";

const container = ref<HTMLElement | null>(null);
const diagnostics = ref(0);
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let model: monaco.editor.ITextModel | null = null;
let listener: monaco.IDisposable | null = null;

onMounted(() => {
  registerTeaseScriptLanguage();
  model = monaco.editor.createModel(
    'say "Hello, editor!", instant\nshowButton "Continue"\n',
    "teasescript",
    monaco.Uri.parse("file:///main.tease"),
  );
  editor = monaco.editor.create(container.value!, {
    model,
    language: "teasescript",
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 15,
    padding: { top: 16 },
  });
  listener = watchDiagnostics(model, (count) => {
    diagnostics.value = count;
  });
});
onBeforeUnmount(() => {
  listener?.dispose();
  editor?.dispose();
  model?.dispose();
});
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
    <section ref="container" class="editor" aria-label="TeaseScript source editor" />
  </main>
</template>
