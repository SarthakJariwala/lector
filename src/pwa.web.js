import { registerSW } from "virtual:pwa-register";

export function registerPwa() {
  if ("serviceWorker" in navigator) {
    registerSW({ immediate: true });
  }
}
