<script setup lang="ts">
import { computed } from "vue";
import { ZcMarket } from "@/types/zc";

const props = withDefaults(
  defineProps<{
    market: ZcMarket;
    size?: number;
    bare?: boolean;
  }>(),
  {
    size: 20,
    bare: false
  }
);

const src = computed(() =>
  props.market === "ERG" ? "/asset-icons/ergo.png" : "/asset-icons/sigusd.svg"
);
</script>

<template>
  <img
    :src="src"
    :alt="market"
    :width="size"
    :height="size"
    class="shrink-0"
    :class="bare ? 'object-contain' : 'rounded-full object-cover ring-1 ring-slate-900/10'"
    :style="{ width: `${size}px`, height: `${size}px` }"
  />
</template>
