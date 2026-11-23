<script setup lang="ts">
import { computed } from "vue";
import { ZcAskSummary, ZcMarket } from "@/types/zc";

type OrderMarkKind = ZcAskSummary["kind"] | "offer";

const props = withDefaults(
  defineProps<{
    kind: OrderMarkKind;
    size?: number;
    market?: ZcMarket;
    title?: string;
  }>(),
  {
    size: 28,
    market: undefined,
    title: undefined
  }
);

const src = computed(() => {
  const base = import.meta.env.BASE_URL;
  if (props.kind === "offer") return `${base}img/sigmafi/offer.svg`;
  if (props.kind === "order") return `${base}img/sigmafi/bond-light.svg`;
  return `${base}img/sigmafi/bond-dark.svg`;
});

const label = computed(() => {
  if (props.title) return props.title;
  if (props.kind === "offer") {
    return props.market ? `${props.market} lend offer` : "SigmaFi lend offer";
  }
  if (props.kind === "order") return "New borrow request";
  if (props.kind === "shares") return "Bond shares resale";
  return "Bond resale";
});
</script>

<template>
  <span
    class="zc-order-mark"
    role="img"
    :aria-label="label"
    :title="label"
    :style="{ width: `${size}px`, height: `${size}px` }"
  >
    <img :src="src" alt="" :width="size" :height="size" class="zc-order-mark-img" />
    <svg
      v-if="kind === 'shares'"
      class="zc-share-badge"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <rect
        x=".75"
        y=".75"
        width="14.5"
        height="14.5"
        rx="3"
        fill="#1c1830"
        stroke="#b7a6fa"
        stroke-width="1.2"
      />
      <path d="M4 4h3v3H4zm5 0h3v3H9zM4 9h3v3H4zm5 0h3v3H9z" fill="#c5b6fa" />
    </svg>
  </span>
</template>

<style scoped>
.zc-order-mark {
  position: relative;
  display: inline-block;
  flex: none;
  border-radius: 50%;
}

.zc-order-mark-img {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 50%;
}

.zc-share-badge {
  position: absolute;
  right: -6%;
  bottom: -4%;
  width: 40%;
  height: 40%;
  overflow: visible;
  pointer-events: none;
}
</style>
