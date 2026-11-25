import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref } from "vue";
import { getCurrentTheme, setTheme } from "@/utils";

function readInitialKyaAccepted(): boolean {
  try {
    return localStorage.getItem("KYAAccepted") === "true";
  } catch {
    return false;
  }
}

export const useUIStore = defineStore("ui", () => {
  // state
  const currentTheme = ref<"dark" | "light">(getCurrentTheme());
  const _isKyaAccepted = ref(readInitialKyaAccepted());

  // computed
  const theme = computed(() => currentTheme);
  const isDark = computed(() => currentTheme.value === "dark");
  const isKYAAccepted = computed(() => _isKyaAccepted);

  // actions
  function setAcceptedKYA() {
    try {
      localStorage.setItem("KYAAccepted", "true");
    } catch {
      // Keep acceptance in memory when storage is restricted.
    }
    _isKyaAccepted.value = true;
  }

  function toggleTheme() {
    if (currentTheme.value === "dark") {
      currentTheme.value = "light";
    } else {
      currentTheme.value = "dark";
    }

    setTheme(currentTheme.value);
    try {
      localStorage.setItem("sigmafi.theme", currentTheme.value);
    } catch {
      // Keep the theme for this session when storage is restricted.
    }
  }

  return { theme, isDark, isKYAAccepted, toggleTheme, setAcceptedKYA };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useUIStore, import.meta.hot));
}
