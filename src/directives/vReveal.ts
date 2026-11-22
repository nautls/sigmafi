import type { ObjectDirective } from "vue";

let observer: IntersectionObserver | undefined;

export const vReveal: ObjectDirective<HTMLElement, number | undefined> = {
  mounted(el, binding) {
    const delay = typeof binding.value === "number" ? binding.value : 0;
    if (delay > 0) {
      el.style.setProperty("--sf-reveal-delay", `${delay}ms`);
    }

    if (
      !("IntersectionObserver" in window) ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      el.setAttribute("data-reveal", "shown");
      return;
    }

    observer ??= new IntersectionObserver(
      (entries, activeObserver) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.setAttribute("data-reveal", "shown");
          activeObserver.unobserve(entry.target);
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );

    el.setAttribute("data-reveal", "hidden");
    observer.observe(el);
  },
  unmounted(el) {
    observer?.unobserve(el);
  }
};
