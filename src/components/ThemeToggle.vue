<script setup lang="ts">
import { MoonIcon, SunIcon } from "@zhuowenli/vue-feather-icons";
import { useUIStore } from "@/stories/uiStore";

const ui = useUIStore();
</script>

<template>
  <button
    type="button"
    class="theme-toggle"
    :aria-label="ui.isDark ? 'Use light theme' : 'Use dark theme'"
    :title="ui.isDark ? 'Use light theme' : 'Use dark theme'"
    @click="ui.toggleTheme()"
  >
    <sun-icon v-if="ui.isDark" aria-hidden="true" />
    <moon-icon v-else aria-hidden="true" />
  </button>
</template>

<style scoped>
.theme-toggle {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  flex: none;
  border-radius: 9999px;
  color: var(--sf-ink-2);
  transition:
    background-color 0.18s ease,
    color 0.18s ease,
    transform 0.18s ease;
}
.theme-toggle:hover {
  background-color: var(--sf-well);
  color: var(--sf-ink);
}
.theme-toggle:active {
  transform: scale(0.94);
}
.theme-toggle svg {
  width: 18px;
  height: 18px;
}
</style>
