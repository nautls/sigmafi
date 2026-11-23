<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    value: number | null | undefined;
    ratio?: number | null;
    guard?: number | null;
    compact?: boolean;
  }>(),
  {
    ratio: null,
    guard: null,
    compact: false
  }
);

const maxScale = computed(() => {
  const vals = [250, props.value ?? 0, props.ratio ?? 0, props.guard ?? 0];
  return Math.max(...vals) * 1.05;
});

const pctPos = (v: number) => Math.max(0, Math.min(100, (v / maxScale.value) * 100));

const barTone = computed(() => {
  if (props.value == null) return "var(--sf-dim)";
  const r = props.ratio ?? 125;
  if (props.value < r) return "var(--sf-danger)";
  if (props.value < r * 1.15) return "var(--sf-ask)";
  return "var(--sf-bid)";
});

const textClass = computed(() => {
  if (props.value == null) return "text-[color:var(--sf-muted)]";
  const r = props.ratio ?? 125;
  if (props.value < r) return "text-[color:var(--sf-danger)]";
  if (props.value < r * 1.15) return "text-[color:var(--sf-ask)]";
  return "text-[color:var(--sf-bid)]";
});
</script>

<template>
  <div v-if="value != null" class="inline-flex items-center gap-2" :class="compact ? 'w-24' : 'w-36'">
    <div
      class="relative h-1.5 flex-1 overflow-visible rounded-full bg-[color:var(--sf-line-strong)]"
      :title="`Cover ${Math.round(value)}%${ratio ? ` · liquidates under ${ratio}%` : ''}${
        guard ? ` · guard ≥ ${guard}%` : ''
      }`"
    >
      <div
        class="h-full rounded-full transition-all duration-500 ease-out"
        :style="{ width: `${pctPos(value)}%`, backgroundColor: barTone }"
      />
      <!-- Liquidation ratio tick -->
      <span
        v-if="ratio != null"
        class="absolute -top-0.5 h-2.5 w-[1.5px] -translate-x-1/2 rounded-full bg-[color:var(--sf-ink)] opacity-75"
        :style="{ left: `${pctPos(ratio)}%` }"
      />
      <!-- Fill/sale guard marker -->
      <span
        v-if="guard != null && guard !== ratio"
        class="absolute -top-0.5 h-2.5 w-[2px] -translate-x-1/2 rounded-full bg-[color:var(--sf-ask)]"
        :style="{ left: `${pctPos(guard)}%` }"
      />
    </div>
    <span class="sf-mono shrink-0 text-[11px] font-semibold" :class="textClass">
      {{ Math.round(value) }}%
    </span>
  </div>
  <span v-else class="sf-mono text-[10.5px] text-[color:var(--sf-dim)]">Maturity</span>
</template>
