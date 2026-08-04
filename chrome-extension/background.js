async function loadFingerprint() {
  try {
    const url = chrome.runtime.getURL('fingerprint.json');
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn('[browser168] fingerprint load failed', e);
    return null;
  }
}

chrome.runtime.onInstalled.addListener(loadFingerprint);
chrome.runtime.onStartup.addListener(loadFingerprint);
loadFingerprint();
