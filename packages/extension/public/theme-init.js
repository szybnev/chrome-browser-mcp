try {
  const saved = localStorage.getItem('color-scheme');
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta && (saved === 'light' || saved === 'dark')) {
    meta.setAttribute('content', saved);
  }
} catch {
  // ignore storage errors
}
