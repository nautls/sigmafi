<script setup lang="ts">
import { CheckIcon, CopyIcon, LayersIcon, XIcon } from "@zhuowenli/vue-feather-icons";
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useWalletStore } from "@/stories";

export interface PreviewRow {
  label: string;
  value: string;
  tone?: "bid" | "ask" | "cobalt" | "default";
}

export interface ExecutionPreviewPayload {
  title: string;
  subtitle: string;
  badge: string;
  tone?: "bid" | "ask" | "cobalt";
  heroLabel: string;
  heroValue: string;
  heroSub?: string;
  rows: PreviewRow[];
  rawSummary: Record<string, unknown>;
}

const props = defineProps<{
  payload: ExecutionPreviewPayload;
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();

const wallet = useWalletStore();
const copied = ref(false);

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}

onMounted(() => document.addEventListener("keydown", onKey));
onBeforeUnmount(() => document.removeEventListener("keydown", onKey));

async function copyJson() {
  try {
    await navigator.clipboard.writeText(JSON.stringify(props.payload.rawSummary, null, 2));
    copied.value = true;
    window.setTimeout(() => {
      copied.value = false;
    }, 1800);
  } catch {
    // clipboard unavailable
  }
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-md"
    role="dialog"
    aria-modal="true"
    :aria-label="payload.title"
    @click.self="emit('close')"
  >
    <div
      class="sf-modal-card sf-action-dock w-full max-w-md overflow-hidden rounded-[24px] rounded-tr-[8px]"
      :data-tone="payload.tone || 'cobalt'"
    >
      <!-- Header -->
      <div class="sf-panel-head flex items-start justify-between gap-3 px-5 py-4">
        <div>
          <span
            class="sf-mono inline-block rounded-[4px] border px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.11em]"
            :class="
              payload.tone === 'bid'
                ? 'border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
                : payload.tone === 'ask'
                  ? 'border-[color:var(--sf-line-ask)] bg-[color:var(--sf-ask-soft)] text-[color:var(--sf-ask)]'
                  : 'border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]'
            "
          >
            {{ payload.badge }}
          </span>
          <h3 class="sf-display mt-1.5 text-[20px] font-bold leading-tight text-[color:var(--sf-ink)]">
            {{ payload.title }}
          </h3>
          <p class="mt-0.5 text-[12px] text-[color:var(--sf-muted)]">
            {{ payload.subtitle }}
          </p>
        </div>

        <button
          type="button"
          class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[color:var(--sf-muted)] transition-all hover:bg-[color:var(--sf-well-soft)] hover:text-[color:var(--sf-ink)] active:scale-90"
          aria-label="Close preview"
          @click="emit('close')"
        >
          <x-icon class="h-4 w-4" />
        </button>
      </div>

      <!-- Hero Readout -->
      <div class="border-b border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)] px-5 py-4">
        <div class="sf-mono text-[10px] uppercase tracking-[0.11em] text-[color:var(--sf-muted)]">
          {{ payload.heroLabel }}
        </div>
        <div
          class="sf-serif mt-1 text-[32px] font-semibold leading-none"
          :class="
            payload.tone === 'bid'
              ? 'text-[color:var(--sf-bid)]'
              : payload.tone === 'ask'
                ? 'text-[color:var(--sf-ask)]'
                : 'text-[color:var(--sf-ink)]'
          "
        >
          {{ payload.heroValue }}
        </div>
        <div v-if="payload.heroSub" class="sf-mono mt-1.5 text-[12px] text-[color:var(--sf-ink-2)]">
          {{ payload.heroSub }}
        </div>
      </div>

      <!-- Terms Table -->
      <dl class="divide-y divide-[color:var(--sf-line)] px-5 py-1">
        <div
          v-for="row in payload.rows"
          :key="row.label"
          class="flex items-center justify-between gap-4 py-2.5 text-[12px]"
        >
          <dt class="text-[color:var(--sf-muted)]">{{ row.label }}</dt>
          <dd
            class="sf-mono text-right font-semibold"
            :class="
              row.tone === 'bid'
                ? 'text-[color:var(--sf-bid)]'
                : row.tone === 'ask'
                  ? 'text-[color:var(--sf-ask)]'
                  : row.tone === 'cobalt'
                    ? 'text-[color:var(--sf-cobalt)]'
                    : 'text-[color:var(--sf-ink)]'
            "
          >
            {{ row.value }}
          </dd>
        </div>
      </dl>

      <!-- Nautilus v2 -> v3 Batching Notice -->
      <div
        class="mx-5 my-3 flex items-start gap-2.5 rounded-xl border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)]/60 px-3.5 py-2.5 text-[11.5px] leading-relaxed text-[color:var(--sf-ink-2)]"
      >
        <layers-icon class="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--sf-cobalt)]" />
        <div>
          <strong class="font-semibold text-[color:var(--sf-ink)]">
            Nautilus v2 → v3 batching bridge
          </strong>
          <p class="mt-0.5 text-[color:var(--sf-muted)]">
            ZC Standard runs on v3 contracts. Direct wallet signing will activate once v2→v3 bridge
            conversion orders are wired in.
          </p>
        </div>
      </div>

      <!-- Footer -->
      <div
        class="flex flex-wrap items-center justify-between gap-2 border-t border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-5 py-3"
      >
        <button
          type="button"
          class="sf-btn-outline inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[11.5px]"
          @click="copyJson"
        >
          <check-icon v-if="copied" class="h-3.5 w-3.5 text-[color:var(--sf-bid)]" />
          <copy-icon v-else class="h-3.5 w-3.5" />
          <span>{{ copied ? "Copied" : "Copy JSON" }}</span>
        </button>

        <div class="flex items-center gap-2">
          <button
            v-if="!wallet.connected"
            type="button"
            class="sf-btn-outline h-8 rounded-full px-3.5 text-[12px]"
            @click="wallet.connect('nautilus')"
          >
            Connect Nautilus
          </button>
          <button
            type="button"
            class="sf-btn-cobalt h-8 rounded-full px-4 text-[12px]"
            @click="emit('close')"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
