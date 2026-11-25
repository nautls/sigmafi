<script setup lang="ts">
import { CheckIcon, ChevronDownIcon } from "@zhuowenli/vue-feather-icons";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

export interface ZcSelectOption {
  value: string | number;
  label: string;
  shortLabel?: string;
}

const props = withDefaults(
  defineProps<{
    modelValue: string | number;
    options: readonly ZcSelectOption[];
    prefix?: string;
    ariaLabel?: string;
    mono?: boolean;
    align?: "left" | "right";
  }>(),
  {
    prefix: "",
    ariaLabel: "Select option",
    mono: false,
    align: "left"
  }
);

const emit = defineEmits<{
  (e: "update:modelValue", val: string | number): void;
}>();

const open = ref(false);
const rootRef = ref<HTMLElement | null>(null);
const activeIdx = ref(0);

const selectedOption = computed(
  () => props.options.find((o) => o.value === props.modelValue) || props.options[0]
);

function toggle() {
  if (!open.value) {
    const idx = props.options.findIndex((o) => o.value === props.modelValue);
    activeIdx.value = idx >= 0 ? idx : 0;
  }
  open.value = !open.value;
}

function choose(opt: ZcSelectOption) {
  emit("update:modelValue", opt.value);
  open.value = false;
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    open.value = false;
    return;
  }
  if (!open.value) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeIdx.value = (activeIdx.value + 1) % props.options.length;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeIdx.value = (activeIdx.value - 1 + props.options.length) % props.options.length;
  } else if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    const opt = props.options[activeIdx.value];
    if (opt) choose(opt);
  }
}

function onDocMouseDown(e: MouseEvent) {
  if (!open.value) return;
  if (rootRef.value && !rootRef.value.contains(e.target as Node)) {
    open.value = false;
  }
}

onMounted(() => document.addEventListener("mousedown", onDocMouseDown));
onBeforeUnmount(() => document.removeEventListener("mousedown", onDocMouseDown));
</script>

<template>
  <div ref="rootRef" class="relative" @keydown="onKeydown">
    <button
      type="button"
      role="combobox"
      :aria-label="ariaLabel"
      :aria-expanded="open"
      aria-haspopup="listbox"
      class="zc-select-trigger inline-flex h-8 items-center gap-1.5 rounded-[10px] border px-2.5 text-[11px] transition-all active:scale-[0.98]"
      :class="
        open
          ? 'is-open border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-card)] text-[color:var(--sf-ink)]'
          : 'border-[color:var(--sf-line)] bg-[color:var(--sf-seg-bg)] text-[color:var(--sf-ink)] hover:border-[color:var(--sf-line-strong)] hover:bg-[color:var(--sf-card)]'
      "
      @click="toggle"
    >
      <span
        v-if="prefix"
        class="sf-mono text-[9.5px] font-semibold uppercase tracking-[0.08em] text-[color:var(--sf-muted)]"
      >
        {{ prefix }}
      </span>
      <span class="font-semibold" :class="{ 'sf-mono': mono }">
        {{ selectedOption?.shortLabel || selectedOption?.label }}
      </span>
      <chevron-down-icon
        class="h-3 w-3 shrink-0 text-[color:var(--sf-muted)] transition-transform duration-200"
        :class="open ? 'rotate-180 text-[color:var(--sf-cobalt)]' : ''"
      />
    </button>

    <transition name="sf-pop">
      <div
        v-if="open"
        role="listbox"
        :aria-label="ariaLabel"
        class="sf-popover zc-select-menu absolute top-[calc(100%+7px)] z-50 min-w-[156px] overflow-hidden rounded-xl p-1"
        :class="align === 'right' ? 'right-0' : 'left-0'"
      >
        <button
          v-for="(opt, idx) in options"
          :key="String(opt.value)"
          type="button"
          role="option"
          :aria-selected="opt.value === modelValue"
          class="flex w-full items-center justify-between gap-3 rounded-[8px] px-2.5 py-1.5 text-left text-[11.5px] font-medium transition-colors"
          :class="[
            mono ? 'sf-mono' : '',
            opt.value === modelValue
              ? 'bg-[color:var(--sf-cobalt-soft)] font-semibold text-[color:var(--sf-cobalt)]'
              : idx === activeIdx
                ? 'bg-[color:var(--sf-well-soft)] text-[color:var(--sf-ink)]'
                : 'text-[color:var(--sf-ink-2)] hover:bg-[color:var(--sf-well-soft)] hover:text-[color:var(--sf-ink)]'
          ]"
          @mouseenter="activeIdx = idx"
          @click="choose(opt)"
        >
          <span class="whitespace-nowrap">{{ opt.label }}</span>
          <check-icon
            v-if="opt.value === modelValue"
            class="h-3.5 w-3.5 shrink-0 text-[color:var(--sf-cobalt)]"
          />
        </button>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.zc-select-trigger {
  box-shadow: var(--sf-seg-shadow);
}

.zc-select-trigger.is-open {
  box-shadow:
    var(--sf-rim-top),
    0 0 0 3px var(--sf-cobalt-soft);
}

.zc-select-menu {
  transform-origin: top center;
}
</style>
