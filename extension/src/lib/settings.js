// Optional settings, including the Gemini API key.
//
// The key is entered in the panel and kept in chrome.storage.local. It is
// never written to the repository, never logged, and never sent anywhere
// except Google's own endpoint.
//
// WHY THIS IS ACCEPTABLE HERE, AND WHEN IT STOPS BEING
//
// A key that reaches the browser is readable by anyone who can open the
// extension folder or the devtools. That is fine while this runs unpacked on
// one machine: the only person who can read it is the person who typed it.
//
// The moment this is shared - published to the Chrome Web Store, zipped to a
// colleague, committed to a public repo - the key is public and will be
// scraped. At that point it has to move behind a server you control, and the
// extension calls your endpoint instead of Google's.
//
// Without a key the extension behaves exactly as before: everything measured
// locally, no network calls at all.

const KEY = "rangnama.settings.v1";

export const DEFAULTS = {
  geminiApiKey: "",
  // Segmentation is the only thing the model is asked to do. Colour is
  // measured from pixels either way - a vision model guesses hex codes, it
  // does not measure them.
  useGeminiSegmentation: true,
};

export async function loadSettings() {
  try {
    const got = await chrome.storage.local.get(KEY);
    return { ...DEFAULTS, ...(got?.[KEY] ?? {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  try {
    await chrome.storage.local.set({ [KEY]: next });
  } catch {
    /* fall through; the value still applies for this page */
  }
  return next;
}

/** Google AI Studio keys start with AIzaSy and are around 39 characters.
 *
 *  Checked before the first request so a mistyped or wrong-type credential
 *  fails immediately with something readable, rather than as an opaque 400
 *  after a photograph has already been uploaded. OAuth tokens and service
 *  account credentials look quite different and will not work here.
 */
export function looksLikeGeminiKey(key) {
  const k = (key || "").trim();
  if (!k) return { ok: false, why: "No key entered." };
  if (k.startsWith("AQ.") || k.startsWith("ya29.")) {
    return {
      ok: false,
      why: "That looks like a Google OAuth token, not an AI Studio API key. " +
           "API keys start with AIzaSy.",
    };
  }
  if (!k.startsWith("AIza")) {
    return { ok: false, why: "AI Studio keys start with AIzaSy." };
  }
  if (k.length < 30) return { ok: false, why: "That key looks too short." };
  return { ok: true };
}
