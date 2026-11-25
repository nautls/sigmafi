import type { ObjectDirective } from "vue";

const threshold = 0.2;
let observer: IntersectionObserver | undefined;

export const vDrawOnView: ObjectDirective = {
  mounted(el: Element) {
    if (!("IntersectionObserver" in window) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    observer ??= new IntersectionObserver((entries, activeObserver) => {
      for (const entry of entries) {
        if (entry.intersectionRatio < threshold) continue;
        entry.target.setAttribute("data-draw", "entered");
        activeObserver.unobserve(entry.target);
      }
    }, { threshold });

    el.setAttribute("data-draw", "waiting");
    observer.observe(el);
  },
  unmounted(el: Element) {
    observer?.unobserve(el);
  }
};
