(async function () {
  try {
    const url = chrome.runtime.getURL('fingerprint.json');
    const res = await fetch(url);
    const fp = res.ok ? await res.json() : null;

    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('inject.js');
    script.dataset.fp = encodeURIComponent(JSON.stringify(fp || {}));
    script.onload = function () {
      this.remove();
    };
    (document.documentElement || document.head || document.body).appendChild(script);
  } catch (e) {
    console.warn('[browser168] inject failed', e);
  }
})();
