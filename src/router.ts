import { createRouter, createWebHashHistory, RouteRecordRaw } from "vue-router";
import DashboardView from "./views/DashboardView.vue";
import BondsMarketView from "./views/bonds/BondsMarketView.vue";
import LandingView from "./views/landing/LandingView.vue";
import V1Layout from "./views/v1/V1Layout.vue";
import ZcAppLayout from "./views/zc/ZcAppLayout.vue";
import ZcBondView from "./views/zc/ZcBondView.vue";
import ZcMarketView from "./views/zc/ZcMarketView.vue";
import ZcOfferView from "./views/zc/ZcOfferView.vue";
import ZcStudioView from "./views/zc/ZcStudioView.vue";

const routes: RouteRecordRaw[] = [
  { path: "/", name: "landing", component: LandingView },
  {
    path: "/app",
    component: ZcAppLayout,
    children: [
      { path: "", name: "zc-market", component: ZcMarketView },
      { path: "studio", name: "zc-studio", component: ZcStudioView },
      { path: "bond/:id?", name: "zc-bond", component: ZcBondView },
      { path: "offer/:id?", name: "zc-offer", component: ZcOfferView },
      { path: "auctions", name: "zc-auctions", component: ZcMarketView },
      { path: "portfolio", name: "zc-portfolio", component: ZcMarketView }
    ]
  },
  {
    path: "/v1",
    component: V1Layout,
    children: [
      { path: "", name: "v1-market", component: BondsMarketView },
      { path: "dashboard", name: "v1-dashboard", component: DashboardView }
    ]
  },
  { path: "/dashboard", redirect: "/v1/dashboard" }
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior(to) {
    if (to.hash) {
      const target = document.getElementById(to.hash.slice(1));
      if (target) {
        return {
          el: target,
          top: parseFloat(getComputedStyle(target).scrollMarginTop) || 0,
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
        };
      }
    }
    return { top: 0 };
  }
});
