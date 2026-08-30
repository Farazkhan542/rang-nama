// The shopper's colouring profile, persisted locally.
//
// chrome.storage.local, not sync: a profile derived from someone's skin and
// hair is not something to replicate across their devices via a Google account
// without being asked. It stays on the machine it was entered on.
//
// Nothing here leaves the browser. There is no server to send it to, which is
// the point of the architecture rather than an omission.

const KEY = "rangnama.profile.v1";

/** @typedef {{skin: string, hair: string, heightCm: number, savedAt: number}} Profile */

export const DEFAULT_PROFILE = {
  skin: "#b07a52",
  hair: "#1a1110",
  heightCm: 160,
};

export async function loadProfile() {
  try {
    const got = await chrome.storage.local.get(KEY);
    const p = got?.[KEY];
    if (!p || !p.skin || !p.hair) return null;
    return p;
  } catch {
    // Storage can be unavailable in an incognito split context or if the user
    // has blocked site data. Returning null puts the panel into onboarding,
    // which is a working state, rather than throwing on every page load.
    return null;
  }
}

export async function saveProfile(profile) {
  const record = { ...profile, savedAt: Date.now() };
  try {
    await chrome.storage.local.set({ [KEY]: record });
    return record;
  } catch {
    return record; // in-memory for this page at least
  }
}

export async function clearProfile() {
  try {
    await chrome.storage.local.remove(KEY);
  } catch {
    /* nothing to clean up */
  }
}

/** Swatch ladders for the photo-free path.
 *
 *  Spans fair to deep rather than clustering around a European mid-point,
 *  because a ladder whose deepest rung is a light tan is useless to most of
 *  this market. Ten rungs is enough to land within a few dE of most people
 *  without turning the choice into work.
 */
export const SKIN_LADDER = [
  "#f2d7cf", "#eed3bd", "#e8c4a0", "#dcb08a", "#c99a6f",
  "#b07a52", "#a4785f", "#9a7b52", "#6b4a35", "#4a3324",
];

export const HAIR_LADDER = [
  "#0d0b0a", "#241a15", "#3d2b1f", "#5a4030", "#7a5c42",
];
