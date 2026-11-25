<script setup lang="ts">
import {
  AlertTriangleIcon,
  CheckIcon,
  ExternalLinkIcon,
  ShieldIcon,
  XIcon
} from "@zhuowenli/vue-feather-icons";
import { onBeforeUnmount, onMounted } from "vue";
import { useUIStore } from "@/stories";

const props = withDefaults(
  defineProps<{
    canDismiss?: boolean;
  }>(),
  {
    canDismiss: false
  }
);

const emit = defineEmits<{
  (e: "close"): void;
}>();

const ui = useUIStore();

function accept() {
  ui.setAcceptedKYA();
  emit("close");
}

function handleDismiss() {
  if (props.canDismiss) emit("close");
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && props.canDismiss) emit("close");
}

onMounted(() => document.addEventListener("keydown", onKey));
onBeforeUnmount(() => document.removeEventListener("keydown", onKey));
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 p-4 backdrop-blur-md"
    role="dialog"
    aria-modal="true"
    aria-label="Know Your Assumptions"
    @click.self="handleDismiss"
  >
    <div
      class="sf-modal-card sf-action-dock flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-[24px] rounded-tr-[8px]"
      data-tone="cobalt"
    >
      <!-- Header -->
      <div class="sf-panel-head flex shrink-0 items-start justify-between gap-3 px-5 py-4">
        <div class="flex items-start gap-3">
          <span
            class="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] text-[color:var(--sf-cobalt)]"
          >
            <shield-icon class="h-4 w-4" />
          </span>
          <div>
            <span
              class="sf-mono inline-block rounded-[4px] border border-[color:var(--sf-line-cobalt)] bg-[color:var(--sf-cobalt-soft)] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.11em] text-[color:var(--sf-cobalt)]"
            >
              KYA · SigmaFi
            </span>
            <h2 class="sf-display mt-1 text-[20px] font-bold leading-tight text-[color:var(--sf-ink)]">
              Know Your Assumptions
            </h2>
          </div>
        </div>

        <button
          v-if="canDismiss"
          type="button"
          class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[color:var(--sf-muted)] transition-all hover:bg-[color:var(--sf-well-soft)] hover:text-[color:var(--sf-ink)] active:scale-90"
          aria-label="Close KYA"
          @click="handleDismiss"
        >
          <x-icon class="h-4 w-4" />
        </button>
      </div>

      <!-- Scrollable Body -->
      <div class="sf-scroll min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 text-[13px] leading-relaxed text-[color:var(--sf-ink-2)]">
        <p>
          <strong class="font-semibold text-[color:var(--sf-ink)]">SigmaFi</strong> is an open
          source UI for interacting with contracts on the Ergo Blockchain.
        </p>

        <div class="rounded-2xl border border-[color:var(--sf-line)] bg-[color:var(--sf-well-inset)] p-3.5">
          <div class="sf-mono mb-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-[color:var(--sf-muted)]">
            Notice that
          </div>
          <ul class="space-y-2 text-[12.5px]">
            <li class="flex items-start gap-2">
              <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--sf-cobalt)]" />
              <span>We don't log, collect, profile, share or sell your data;</span>
            </li>
            <li class="flex items-start gap-2">
              <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--sf-cobalt)]" />
              <span>
                SigmaFi operates on a live blockchain, thus transactions are final, and irreversible
                once they have status «<strong class="font-semibold text-[color:var(--sf-ink)]">confirmed</strong>»;
              </span>
            </li>
            <li class="flex items-start gap-2">
              <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--sf-cobalt)]" />
              <span>
                Every transaction can be viewed via
                <a
                  href="https://explorer.ergoplatform.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-0.5 font-semibold text-[color:var(--sf-cobalt)] hover:underline"
                >
                  <span>explorer</span>
                  <external-link-icon class="h-3 w-3" />
                </a>;
              </span>
            </li>
            <li class="flex items-start gap-2">
              <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--sf-cobalt)]" />
              <span>
                <a
                  href="https://github.com/Lithos-Protocol/Sigma-Finance-V2"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-0.5 font-semibold text-[color:var(--sf-cobalt)] hover:underline"
                >
                  <span>All code is open source and available</span>
                  <external-link-icon class="h-3 w-3" />
                </a>
                for public review.
              </span>
            </li>
          </ul>
        </div>

        <!-- Warning Callout -->
        <div
          class="space-y-2 rounded-2xl border border-[color:var(--sf-line-ask)] bg-[color:var(--sf-ask-soft)]/70 p-3.5 text-[12.5px] font-semibold text-[color:var(--sf-ink)]"
        >
          <div class="flex items-start gap-2">
            <alert-triangle-icon class="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--sf-ask)]" />
            <div class="space-y-1.5">
              <p>The SigmaFi developers don't guarantee the absence of bugs and errors.</p>
              <p>
                NO assistance can be offered if a user is hacked or cheated out of passwords,
                currency or private keys.
              </p>
              <p class="text-[color:var(--sf-ask)]">
                This is a BETA version — we recommend that you DO NOT use it to make large
                transactions!
              </p>
            </div>
          </div>
        </div>

        <!-- Acceptance Terms -->
        <div class="space-y-2">
          <div class="font-semibold text-[color:var(--sf-ink)]">
            By accepting these KYA, you agree that:
          </div>
          <ol class="list-decimal space-y-1.5 pl-5 text-[12.5px]">
            <li>You will use the product at your own peril and risk;</li>
            <li>Only YOU are responsible for your assets;</li>
            <li>Only YOU are responsible for securely storing your recovery phrase.</li>
          </ol>
        </div>
      </div>

      <!-- Action Footer -->
      <div
        class="shrink-0 border-t border-[color:var(--sf-line)] bg-[color:var(--sf-card)] px-5 py-3.5"
      >
        <button
          type="button"
          class="sf-btn-cobalt flex h-11 w-full items-center justify-center gap-2 rounded-xl px-5 text-[13.5px]"
          @click="accept"
        >
          <check-icon class="h-4 w-4" />
          <span>I understand and accept the KYA</span>
        </button>
      </div>
    </div>
  </div>
</template>
