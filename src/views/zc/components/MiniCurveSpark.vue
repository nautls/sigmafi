<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    points: { d: number; y: number }[];
    width?: number;
    height?: number;
    color?: string;
    title?: string;
    fill?: boolean;
  }>(),
  {
    width: 64,
    height: 22,
    color: "var(--sf-bid)",
    title: "",
    fill: false
  }
);

const coords = computed(() => {
  const pts = props.points || [];
  if (!pts.length) return [];
  const ys = pts.map((p) => p.y);
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const d0 = pts[0].d;
  const d1 = pts[pts.length - 1].d;
  const w = props.width;
  const h = props.height;

  return pts.map((p) => ({
    x: d1 === d0 ? w / 2 : ((p.d - d0) / (d1 - d0)) * (w - 6) + 3,
    y: hi === lo ? h / 2 : h - 3.5 - ((p.y - lo) / (hi - lo)) * (h - 7)
  }));
});

const lineD = computed(() => {
  if (coords.value.length < 2) return "";
  return coords.value
    .map((pt, i) => `${i === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
    .join(" ");
});

const areaD = computed(() => {
  if (!props.fill || coords.value.length < 2) return "";
  const first = coords.value[0];
  const last = coords.value[coords.value.length - 1];
  return `${lineD.value} L${last.x.toFixed(1)},${(props.height - 2).toFixed(1)} L${first.x.toFixed(
    1
  )},${(props.height - 2).toFixed(1)} Z`;
});
</script>

<template>
  <span class="inline-flex items-center align-middle" :title="title || undefined">
    <svg
      v-if="coords.length > 0"
      :width="width"
      :height="height"
      :viewBox="`0 0 ${width} ${height}`"
      class="block overflow-visible"
      aria-hidden="true"
    >
      <path v-if="areaD" :d="areaD" :fill="color" fill-opacity="0.12" />
      <path
        v-if="lineD"
        :d="lineD"
        fill="none"
        :stroke="color"
        stroke-width="1.65"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <circle
        v-if="coords.length === 1"
        :cx="coords[0].x"
        :cy="coords[0].y"
        r="2.4"
        :fill="color"
      />
    </svg>
    <span v-else class="sf-mono text-[10.5px] text-[color:var(--sf-dim)]">flat</span>
  </span>
</template>
