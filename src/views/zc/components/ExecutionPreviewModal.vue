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
    class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm"
    role="dialog"
    aria-modal="true"
    :aria-label="payload.title"
    @click.self="emit('close')"
  >
    <div class="sf-plate w-full max-w-lg overflow-hidden rounded-2xl">
      <!-- Header -->
      <div
        class="flex items-start justify-between gap-3 border-b border-[color:var(--sf-line)] px-5 py-4"
      >
        <div>
          <span
            class="sf-mono inline-block rounded bg-cobalt-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.11em] text-cobalt-700 ring-1 ring-cobalt-600/20"
          >
            {{ payload.badge }}
          </span>
          <h3 class="sf-serif mt-1.5 text-[22px] font-semibold leading-tight text-[color:var(--sf-ink)]">
            {{ payload.title }}
          </h3>
          <p class="mt-0.5 text-[12.5px] text-[color:var(--sf-muted)]">
            {{ payload.subtitle }}
          </p>
        </div>

        <button
          type="button"
          class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[color:var(--sf-muted)] hover:bg-[color:var(--sf-well)] hover:text-[color:var(--sf-ink)]"
          aria-label="Close preview"
          @click="emit('close')"
        >
          <x-icon class="h-4 w-4" />
        </button>
      </div>

      <!-- Hero Readout -->
      <div class="border-b border-[color:var(--sf-line)] bg-[color:var(--sf-paper)] px-5 py-4">
        <div class="sf-mono text-[10px] uppercase tracking-[0.11em] text-[color:var(--sf-muted)]">
          {{ payload.heroLabel }}
        </div>
        <div class="sf-serif mt-1 text-[32px] font-semibold leading-none text-[color:var(--sf-ink)]">
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
          class="flex items-center justify-between gap-4 py-2.5 text-[12.5px]"
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
                    ? 'text-cobalt-600'
                    : 'text-[color:var(--sf-ink)]'
            "
          >
            {{ row.value }}
          </dd>
        </div>
      </dl>

      <!-- Nautilus v2 -> v3 Batching Notice -->
      <div
        class="mx-5 my-3 flex items-start gap-2.5 rounded-xl border border-cobalt-600/25 bg-cobalt-50/75 px-3.5 py-3 text-[12px] leading-relaxed text-[color:var(--sf-ink-2)]"
      >
        <layers-icon class="mt-0.5 h-4 w-4 shrink-0 text-cobalt-600" />
        <div>
          <strong class="font-semibold text-[color:var(--sf-ink)]">
            Nautilus v2 → v3 batching bridge
          </strong>
          <p class="mt-0.5 text-[color:var(--sf-muted)]">
            ZC Standard contracts run on v3 boxes. Nautilus signs v2 conversion orders that Lithos
            batchers fold into v3 boxes automatically — submission signing will be enabled once the
            v2→v3 bridge contracts are wired in.
          </p>
        </div>
      </div>

      <!-- Footer -->
      <div
        class="flex flex-wrap items-center justify-between gap-2 border-t border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-5 py-3.5"
      >
        <button
          type="button"
          class="sf-btn-outline inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[12px]"
          @click="copyJson"
        >
          <check-icon v-if="copied" class="h-3.5 w-3.5 text-[color:var(--sf-bid)]" />
          <copy-icon v-else class="h-3.5 w-3.5" />
          <span>{{ copied ? "Copied quote" : "Copy quote JSON" }}</span>
        </button>

        <div class="flex items-center gap-2">
          <button
            v-if="!wallet.connected"
            type="button"
            class="sf-btn-outline h-9 rounded-lg px-3.5 text-[12.5px]"
            @click="wallet.connect('nautilus')"
          >
            Connect Nautilus
          </button>
          <button
            type="button"
            class="sf-btn-primary h-9 rounded-lg px-4 text-[12.5px]"
            @click="emit('close')"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
