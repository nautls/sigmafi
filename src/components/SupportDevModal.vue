<script setup lang="ts">
import {
  CheckIcon,
  CopyIcon,
  HeartIcon,
  XIcon
} from "@zhuowenli/vue-feather-icons";
import { onBeforeUnmount, onMounted, ref } from "vue";

export interface DevContributor {
  readonly role: string;
  readonly address: string;
  readonly note?: string;
}

const CONTRIBUTORS: readonly DevContributor[] = [
  {
    role: "Lead Developer (SC & UI)",
    address: "9i5H4VAMQBNeWGHEXma8MGrHnb7P4N9STG1UXowcngAE5ZyZsjc"
  }
];

const emit = defineEmits<{
  (e: "close"): void;
}>();

const copiedAddress = ref<string | null>(null);
let copyTimer: number | null = null;

async function copyAddress(addr: string) {
  try {
    await navigator.clipboard.writeText(addr);
    copiedAddress.value = addr;
    if (copyTimer !== null) window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => {
      copiedAddress.value = null;
    }, 1800);
  } catch {
    // clipboard unavailable
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}

onMounted(() => document.addEventListener("keydown", onKey));
onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKey);
  if (copyTimer !== null) window.clearTimeout(copyTimer);
});
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-md"
    role="dialog"
    aria-modal="true"
    aria-label="Support Development"
    @click.self="emit('close')"
  >
    <div
      class="sf-modal-card sf-action-dock flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-[24px] rounded-tr-[8px]"
      data-tone="cobalt"
    >
      <!-- Header -->
      <div class="sf-panel-head flex shrink-0 items-start justify-between gap-3 px-5 py-4">
        <div class="flex items-start gap-3">
          <span
            class="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]"
          >
            <heart-icon class="h-4 w-4" />
          </span>
          <div>
            <span
              class="sf-mono inline-block rounded-[4px] border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.11em] text-[color:var(--sf-cobalt)]"
            >
              0% Dev Fee
            </span>
            <h3 class="sf-display mt-1 text-[20px] font-bold leading-tight text-[color:var(--sf-ink)]">
              Support Development
            </h3>
          </div>
        </div>

        <button
          type="button"
          class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[color:var(--sf-muted)] transition-all hover:bg-[color:var(--sf-well-soft)] hover:text-[color:var(--sf-ink)] active:scale-90"
          aria-label="Close"
          @click="emit('close')"
        >
          <x-icon class="h-4 w-4" />
        </button>
      </div>

      <!-- Body -->
      <div class="sf-scroll min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <p class="text-[13.5px] leading-relaxed text-[color:var(--sf-ink-2)]">
          SigmaFi V2 takes no dev fee and was developed entirely for free. Please consider donating
          to help support continued development of SigmaFi and other applications on Ergo.
        </p>

        <!-- Contributor Donation Addresses (extensible list) -->
        <div class="space-y-2.5">
          <div
            v-for="dev in CONTRIBUTORS"
            :key="dev.address"
            class="rounded-2xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)] p-3.5"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="text-[12px] font-semibold text-[color:var(--sf-ink)]">
                — {{ dev.role }}
              </span>
              <button
                type="button"
                class="sf-mono inline-flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1 text-[10.5px] font-semibold transition-colors"
                :class="
                  copiedAddress === dev.address
                    ? 'border-[color:var(--sf-line-bid)] bg-[color:var(--sf-bid-soft)] text-[color:var(--sf-bid)]'
                    : 'border-[color:var(--sf-line-strong)] bg-[color:var(--sf-card)] text-[color:var(--sf-ink-2)] hover:border-[color:var(--sf-line-cobalt)] hover:text-[color:var(--sf-cobalt)]'
                "
                @click="copyAddress(dev.address)"
              >
                <check-icon v-if="copiedAddress === dev.address" class="h-3 w-3" />
                <copy-icon v-else class="h-3 w-3" />
                <span>{{ copiedAddress === dev.address ? "Copied" : "Copy" }}</span>
              </button>
            </div>

            <div
              class="sf-mono mt-2 select-all break-all rounded-xl border border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-3 py-2 text-[11.5px] leading-relaxed text-[color:var(--sf-ink)]"
            >
              {{ dev.address }}
            </div>

            <p v-if="dev.note" class="mt-1.5 text-[11px] text-[color:var(--sf-muted)]">
              {{ dev.note }}
            </p>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div
        class="flex shrink-0 items-center justify-end border-t border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-5 py-3"
      >
        <button
          type="button"
          class="sf-btn-outline h-9 rounded-full px-5 text-[12.5px] font-semibold"
          @click="emit('close')"
        >
          Close
        </button>
      </div>
    </div>
  </div>
</template>
