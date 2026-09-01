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

/** A shape check, not a format assertion.
 *
 *  An earlier version required keys to start with AIzaSy and rejected
 *  anything else. That was wrong: AI Studio also issues keys beginning "AQ.",
 *  and the check would have refused a working credential with a confident
 *  message about the correct prefix. Guessing a vendor's key format from
 *  memory is not validation.
 *
 *  So only obvious non-keys are caught here - an empty field, or a Google
 *  OAuth access token, which is a different credential type the API rejects
 *  with a 401. Everything else is passed through and the API decides, since
 *  its error message is authoritative and this file's opinion is not.
 */
export function looksLikeGeminiKey(key) {
  const k = (key || "").trim();
  if (!k) return { ok: false, why: "No key entered." };
  if (k.startsWith("ya29.")) {
    return {
      ok: false,
      why: "That is a Google OAuth access token, not an API key. " +
           "Create one at aistudio.google.com/apikey.",
    };
  }
  if (k.length < 20) return { ok: false, why: "That key looks too short." };
  return { ok: true };
}
