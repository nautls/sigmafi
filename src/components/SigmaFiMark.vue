<script setup lang="ts">
withDefaults(
  defineProps<{
    size?: number;
  }>(),
  {
    size: 28
  }
);

const logoSrc = `${import.meta.env.BASE_URL}favicon.svg`;
</script>

<template>
  <img
    :src="logoSrc"
    alt=""
    aria-hidden="true"
    :width="size"
    :height="size"
    class="block shrink-0 rounded-full object-contain"
    :style="{ width: `${size}px`, height: `${size}px` }"
  />
</template>
