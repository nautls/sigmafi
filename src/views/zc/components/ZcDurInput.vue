<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ZcDurationUnit } from "@/types/zc";
import { DAY_BLOCKS } from "@/utils/zcMath";

const props = withDefaults(
  defineProps<{
    modelValue: number | null;
    unit: ZcDurationUnit;
    of?: "days" | "blocks";
    tone?: "bid" | "ask" | "cobalt";
    placeholder?: string;
    ariaLabel?: string;
    disabled?: boolean;
  }>(),
  {
    of: "days",
    tone: "cobalt",
    placeholder: "0",
    ariaLabel: "Duration",
    disabled: false
  }
);

const emit = defineEmits<{
  (e: "update:modelValue", val: number | null): void;
}>();

const inBlocks = computed(() => props.unit === "blocks");

function toDisplay(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "";
  if (props.of === "days") {
    return inBlocks.value ? String(Math.round(v * DAY_BLOCKS)) : String(Number(v.toFixed(2)));
  }
  return inBlocks.value ? String(Math.round(v)) : String(Number((v / DAY_BLOCKS).toFixed(2)));
}

const text = ref(toDisplay(props.modelValue));
const focused = ref(false);

watch(
  [() => props.modelValue, () => props.unit],
  () => {
    if (!focused.value) {
      text.value = toDisplay(props.modelValue);
    }
  },
  { immediate: true }
);

function onInput(e: Event) {
  const raw = (e.target as HTMLInputElement).value.replace(/[^0-9.]/g, "");
  const parts = raw.split(".");
  const clean = parts.length > 2 ? `${parts[0]}.${parts.slice(1).join("")}` : raw;
  text.value = clean;
  if (clean === "") {
    emit("update:modelValue", null);
    return;
  }
  const n = Number(clean);
  if (!Number.isFinite(n) || n < 0) return;
  if (props.of === "days") {
    emit("update:modelValue", inBlocks.value ? n / DAY_BLOCKS : n);
  } else {
    emit("update:modelValue", inBlocks.value ? Math.round(n) : Math.round(n * DAY_BLOCKS));
  }
}

function onBlur() {
  focused.value = false;
  text.value = toDisplay(props.modelValue);
}
</script>

<template>
  <div
    class="sf-input-well flex h-9 items-center gap-1.5 rounded-xl px-2.5"
    :data-tone="tone"
    :class="disabled ? 'opacity-50' : ''"
  >
    <input
      :value="text"
      inputmode="decimal"
      autocomplete="off"
      :disabled="disabled"
      :placeholder="placeholder"
      :aria-label="ariaLabel"
      class="sf-mono w-full min-w-0 bg-transparent text-[13.5px] font-semibold text-[color:var(--sf-ink)] placeholder-[color:var(--sf-dim)] outline-none"
      @focus="focused = true"
      @blur="onBlur"
      @input="onInput"
    />
    <span class="sf-mono shrink-0 text-[10.5px] font-semibold text-[color:var(--sf-muted)]">
      {{ inBlocks ? "blk" : "d" }}
    </span>
  </div>
</template>
