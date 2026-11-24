// Applies the saved theme before first paint so there is no flash of the wrong one.
// Kept as a file (not inline) so the Content-Security-Policy can forbid inline scripts.
(function () {
  var mode = 'system';
  try {
    mode = localStorage.getItem('delta.hrms.theme') || 'system';
  } catch (e) {}
  if (mode !== 'light' && mode !== 'dark') {
    // Nothing chosen: follow the device (the same rule as ThemeContext).
    mode = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.dataset.theme = mode;
})();
