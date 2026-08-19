/** Copy text in browsers that may not expose navigator.clipboard (for example HTTP). */
export const copyText = async (value: string): Promise<void> => {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(value);
      return;
    } catch {
      // Continue with the DOM fallback when permissions or the secure context
      // prevent the asynchronous clipboard API from being used.
    }
  }

  if (typeof document === 'undefined' || !document.body) {
    throw new Error('copy unavailable');
  }

  const fallback = document.createElement('textarea');
  fallback.value = value;
  fallback.setAttribute('readonly', '');
  fallback.setAttribute('aria-hidden', 'true');
  fallback.style.position = 'fixed';
  fallback.style.top = '0';
  fallback.style.left = '-9999px';
  fallback.style.opacity = '0';
  document.body.appendChild(fallback);
  fallback.focus();
  fallback.select();
  fallback.setSelectionRange(0, value.length);
  let copied = false;
  try {
    copied = typeof document.execCommand === 'function' && document.execCommand('copy');
  } finally {
    fallback.remove();
  }
  if (!copied) throw new Error('copy unavailable');
};
