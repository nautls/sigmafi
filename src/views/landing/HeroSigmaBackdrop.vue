<script setup lang="ts">
import { vDrawOnView } from "@/directives/vDrawOnView";
</script>

<template>
  <svg
    v-draw-on-view
    class="sigma-drawing"
    viewBox="0 0 520 292"
    fill="none"
    aria-hidden="true"
    focusable="false"
  >
    <defs>
      <path
        id="sigma-outline"
        pathLength="1"
        d="M368 42H160L256 145L157 249H369L375 200H366
        Q358 228 337 228H204L287 143L214 63H336Q354 63 359 89H368Z"
      />
      <pattern
        id="sigma-engraving"
        width="5"
        height="5"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(32)"
      >
        <path d="M0 0V5" stroke="currentColor" stroke-width="1.4" />
      </pattern>
    </defs>
    <g class="guides">
      <path d="M7 145H513M128 42H419M125 249H419M160 20V270M368 20V270" />
      <circle cx="264" cy="145" r="133" stroke-dasharray="2 6" />
      <path d="M338 12A149 149 0 0 1 412 165" />
      <path d="M130 265L391 5M132 13L389 272" stroke-dasharray="5 6" />
    </g>
    <use href="#sigma-outline" fill="currentColor" opacity=".12" />
    <use href="#sigma-outline" fill="url(#sigma-engraving)" opacity=".45" />
    <use href="#sigma-outline" class="sigma-contour" />
    <g class="registration">
      <path d="M119 42h10m-5-5v10M398 249h10m-5-5v10" />
      <circle cx="256" cy="145" r="3.4" />
      <circle cx="368" cy="42" r="2.5" />
    </g>
  </svg>
</template>

<style scoped>
.sigma-drawing {
  width: 100%;
  height: auto;
  display: block;
  color: var(--sf-cobalt);
  pointer-events: none;
  filter: drop-shadow(0 0 24px var(--sf-cobalt-soft));
}
.guides {
  stroke: currentColor;
  stroke-width: 0.9;
  opacity: 0.28;
}
.sigma-contour {
  stroke: currentColor;
  opacity: 0.85;
  stroke-width: 1.75;
  stroke-linejoin: round;
}
.registration {
  stroke: currentColor;
  stroke-width: 1.2;
  fill: var(--sf-card);
}
@media (prefers-reduced-motion: no-preference) {
  [data-draw="waiting"] .sigma-contour {
    visibility: hidden;
  }
  [data-draw="entered"] .sigma-contour {
    stroke-dasharray: 1;
    animation: engrave 2s cubic-bezier(0.22, 0.7, 0.3, 1) both;
  }
  @keyframes engrave {
    from {
      stroke-dashoffset: 1;
    }
    to {
      stroke-dashoffset: 0;
    }
  }
}
</style>
