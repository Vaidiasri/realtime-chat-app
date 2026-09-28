/* global localStorage, matchMedia, document */
// Before first paint, so a dark page never flashes light. A file, not inline: the CSP blocks inline scripts.
try {
  const t = localStorage.getItem('theme');
  if (t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches))
    document.documentElement.classList.add('dark');
} catch {
  // Storage blocked (private mode): fall back to the light default.
}
