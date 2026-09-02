// Creates the offscreen document on demand and relays messages to it.
//
// Only one offscreen document may exist at a time, and creating it twice
// throws - so creation is guarded by a promise rather than a boolean, or two
// simultaneous requests race and the second fails.

let creating = null;

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;

  if (creating) return creating;

  creating = chrome.offscreen.createDocument({
    url: "offscreen.html",
    // DOM_PARSER is the closest documented reason for "needs a DOM and canvas
    // to run an image pipeline"; there is no image-processing reason in the
    // enum.
    reasons: ["DOM_PARSER"],
    justification: "Runs the MediaPipe face mesh, which cannot load in a content script.",
  });
  try {
    await creating;
  } finally {
    creating = null;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "background") return false;

  (async () => {
    try {
      await ensureOffscreen();
      const res = await chrome.runtime.sendMessage({ ...msg, target: "offscreen" });
      sendResponse(res);
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true;
});
