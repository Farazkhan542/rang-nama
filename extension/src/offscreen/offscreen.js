// Runs MediaPipe on behalf of the content script.
//
// Receives two images as data URLs, returns the composited result as a data
// URL. Images cross the message boundary as strings because structured clone
// does not carry an ImageBitmap to a content script in every Chrome version,
// and the sizes here are small enough that it does not matter.

import { swapFace } from "../lib/faceswap.js";
import { getLandmarker } from "../lib/facemesh.js";

async function toImage(src) {
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("image failed to decode"));
    img.src = src;
  });
  return img;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return false;

  (async () => {
    try {
      if (msg.type === "ping") {
        const started = performance.now();
        await getLandmarker();
        sendResponse({ ok: true, ms: Math.round(performance.now() - started) });
        return;
      }

      if (msg.type === "swap") {
        const [me, target] = await Promise.all([
          toImage(msg.personDataUrl),
          toImage(msg.targetDataUrl),
        ]);
        const started = performance.now();
        const { canvas, frontality, reliable } = await swapFace(me, target);
        sendResponse({
          ok: true,
          dataUrl: canvas.toDataURL("image/jpeg", 0.92),
          ms: Math.round(performance.now() - started),
          frontality,
          reliable,
        });
        return;
      }

      sendResponse({ ok: false, error: `unknown message ${msg.type}` });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true; // async response
});
