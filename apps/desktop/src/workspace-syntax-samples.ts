// Shared acceptance samples for browser and native tokenizer fixtures.
export const workspaceSyntaxSamples = {
  "/syntax/Welcome.vue": `<script setup lang="ts">
/* Vue comment starts here
   and continues here */
const title: string = \`Hello 🚀
  Workspace\`;
</script>
<template><h1>{{ title }}</h1></template>
<style lang="scss">
$accent: #7c3aed;
h1 {
  color: $accent;
}
</style>`,
  "/syntax/Welcome.svelte": `<script lang="ts">
/* Svelte comment starts here
   and continues here */
const title: string = \`Hello 🚀
  Workspace\`;
</script>
<h1>{title}</h1>
<style>
/* Embedded CSS comment
   continues here */
h1 { color: rebeccapurple; }
</style>`,
  "/syntax/Welcome.astro": `---
/* Astro comment starts here
   and continues here */
const title: string = \`Hello 🚀
  Workspace\`;
---
<h1>{title}</h1>
<script>const icon = "🚀"; const ready: boolean = true;</script>
<style>
/* Embedded CSS comment
   continues here */
h1 { color: rebeccapurple; }
</style>`,
  "/syntax/theme.sass": `// Indentation based Sass
$accent: #7c3aed
$title: "Workspace"
/* Sass comment starts here
   and continues here */
.welcome
  color: $accent
  content: $title
  &:hover
    color: lighten($accent, 12%)`,
} as const;
