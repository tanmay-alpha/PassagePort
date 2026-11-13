// Applies the saved theme before first paint. Keep in sync with src/lib/theme.ts.
(function () {
  var preference = null
  try {
    preference = window.localStorage.getItem('pp.theme')
  } catch (error) {
    // Storage can be blocked; fall back to the system preference.
  }
  var systemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
  var dark = preference === 'dark' || (preference !== 'light' && systemDark)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  var meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', dark ? '#121413' : '#FAFAF7')
})()
