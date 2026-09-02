// Temporary spike: does MediaPipe load and find faces in a content script?
import { findFace, frontality, getLandmarker } from "../lib/facemesh.js";

async function spike() {
  console.log("[spike] loading MediaPipe…");
  const t0 = performance.now();
  try {
    await getLandmarker();
    console.log(`[spike] landmarker ready in ${(performance.now() - t0).toFixed(0)}ms`);
  } catch (err) {
    console.error("[spike] LOAD FAILED:", err.message);
    return;
  }

  const imgs = [...document.images]
    .filter((i) => i.naturalWidth > 300 && i.naturalHeight > 300)
    .slice(0, 4);
  console.log(`[spike] testing ${imgs.length} page images`);

  for (const img of imgs) {
    const t = performance.now();
    try {
      const face = await findFace(img);
      const ms = (performance.now() - t).toFixed(0);
      if (!face) {
        console.log(`[spike]   no face  ${ms}ms  ${img.src.split("/").pop().slice(0, 40)}`);
        continue;
      }
      console.log(
        `[spike]   FACE ${face.points.length} pts  ${ms}ms  ` +
        `box ${face.box.w.toFixed(0)}x${face.box.h.toFixed(0)}  ` +
        `frontality ${frontality(face).toFixed(2)}  ` +
        img.src.split("/").pop().slice(0, 36)
      );
    } catch (e) {
      console.log(`[spike]   error: ${e.message.slice(0, 80)}`);
    }
  }
}
spike();
