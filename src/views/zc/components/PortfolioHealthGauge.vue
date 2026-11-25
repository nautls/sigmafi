<script setup lang="ts">
import { computed } from "vue";
import { formatNumber } from "@/utils/zcMath";

const props = defineProps<{
  value: number | null;
}>();

const R = 48;
const CX = 60;
const CY = 60;
const ARC = `M${CX - R} ${CY} A${R} ${R} 0 0 1 ${CX + R} ${CY}`;

const pctAt = (v: number) => Math.min(100, Math.max(0, ((v - 0.8) / 1.2) * 100));

function pointOnArc(fracPct: number, radius: number): [number, number] {
  const a = Math.PI * (1 - fracPct / 100);
  return [CX + radius * Math.cos(a), CY - radius * Math.sin(a)];
}

const tone = computed<"danger" | "warn" | "bid" | null>(() => {
  if (props.value == null) return null;
  if (props.value < 1.05) return "danger";
  if (props.value < 1.25) return "warn";
  return "bid";
});

const strokeColor = computed(() => {
  if (tone.value === "danger") return "var(--sf-danger)";
  if (tone.value === "warn") return "var(--sf-ask)";
  if (tone.value === "bid") return "var(--sf-bid)";
  return "var(--sf-dim)";
});

const fillPct = computed(() => (props.value == null ? 0 : pctAt(props.value)));
const knob = computed(() => pointOnArc(fillPct.value, R));
const liqTickInner = pointOnArc(pctAt(1.0), R - 8);
const liqTickOuter = pointOnArc(pctAt(1.0), R + 7);
const badEnd = pctAt(1.05);
const warnSpan = pctAt(1.25) - badEnd;

const displayVal = computed(() => {
  if (props.value == null) return "—";
  if (props.value >= 10) return "9.99+";
  return formatNumber(props.value, 2, 2);
});
</script>

<template>
  <div class="relative mx-auto w-[136px] select-none">
    <svg viewBox="0 0 120 68" class="block h-auto w-full overflow-visible" aria-hidden="true">
      <!-- Track -->
      <path
        :d="ARC"
        pathLength="100"
        fill="none"
        stroke="var(--sf-line-strong)"
        stroke-width="7"
        stroke-linecap="round"
      />
      <!-- Danger zone (<1.05) -->
      <path
        :d="ARC"
        pathLength="100"
        fill="none"
        stroke="var(--sf-danger)"
        stroke-opacity="0.26"
        stroke-width="7"
        :stroke-dasharray="`${badEnd} 100`"
      />
      <!-- Caution zone (1.05-1.25) -->
      <path
        :d="ARC"
        pathLength="100"
        fill="none"
        stroke="var(--sf-ask)"
        stroke-opacity="0.26"
        stroke-width="7"
        :stroke-dasharray="`${warnSpan} 100`"
        :stroke-dashoffset="-badEnd"
      />
      <!-- Live value arc -->
      <path
        v-if="value != null"
        :d="ARC"
        pathLength="100"
        fill="none"
        :stroke="strokeColor"
        stroke-width="7"
        stroke-linecap="round"
        :stroke-dasharray="`${fillPct} 100`"
        class="transition-all duration-500 ease-out"
      />
      <!-- 1.00 Liquidation Threshold Tick -->
      <line
        :x1="liqTickInner[0]"
        :y1="liqTickInner[1]"
        :x2="liqTickOuter[0]"
        :y2="liqTickOuter[1]"
        stroke="var(--sf-ink)"
        stroke-width="1.6"
        stroke-opacity="0.7"
      />
      <!-- Knob -->
      <circle
        v-if="value != null"
        :cx="knob[0]"
        :cy="knob[1]"
        r="5"
        :fill="strokeColor"
        stroke="var(--sf-card)"
        stroke-width="2"
        class="transition-all duration-500 ease-out"
      />
    </svg>

    <div class="pointer-events-none absolute inset-x-0 bottom-0.5 text-center">
      <div
        class="sf-serif text-[26px] font-semibold leading-none"
        :class="
          tone === 'danger'
            ? 'text-[color:var(--sf-danger)]'
            : tone === 'warn'
              ? 'text-[color:var(--sf-ask)]'
              : tone === 'bid'
                ? 'text-[color:var(--sf-bid)]'
                : 'text-[color:var(--sf-dim)]'
        "
      >
        {{ displayVal }}
      </div>
    </div>
  </div>
</template>
