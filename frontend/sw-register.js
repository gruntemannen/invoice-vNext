// Service worker registration. Kept in an external file (not inline) so the page can
// ship a strict Content-Security-Policy with script-src 'self' — no inline scripts.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
