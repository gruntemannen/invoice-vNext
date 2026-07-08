// The admin console is auth/config sensitive, so stale app-shell caching is not
// worth the operational risk. Remove any previously installed PWA worker.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch(() => {});
  });
}

if ("caches" in window) {
  window.addEventListener("load", () => {
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("invoice-admin-pwa")).map((key) => caches.delete(key))))
      .catch(() => {});
  });
}
