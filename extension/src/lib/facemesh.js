// Face landmarks, in the page, in real time.
//
// MediaPipe Face Landmarker gives 478 points per face at video framerate. That
// is what makes face replacement possible where try-on is not: try-on has to
// synthesise cloth and takes tens of seconds on a GPU, while replacing a face
// only moves a few thousand pixels around geometry we already have.
//
// The runtime and model are bundled into the extension rather than fetched
// from Google's CDN. A CDN load would be blocked by the host page's CSP on
// some sites and would silently make this a network dependency, which is the
// property the rest of the extension is built to avoid.

import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

let landmarker = null;
let loading = null;

/** Load once, share across calls. The WASM is 11 MB and compiling it per use
 *  would dominate everything else. */
export async function getLandmarker() {
  if (landmarker) return landmarker;
  if (loading) return loading;

  loading = (async () => {
    const fileset = await FilesetResolver.forVisionTasks(
      chrome.runtime.getURL("vendor/wasm")
    );
    landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: chrome.runtime.getURL("vendor/models/face_landmarker.task"),
        delegate: "GPU",
      },
      runningMode: "IMAGE",
      numFaces: 1,
      // Blendshapes and the transform matrix are not needed for a warp, and
      // asking for them costs time on every call.
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    });
    return landmarker;
  })();

  try {
    return await loading;
  } catch (err) {
    loading = null;
    throw new Error(
      `face landmarker failed to load: ${err.message}. ` +
      `If this is a WASM CompileError the host page's CSP is blocking it, ` +
      `and the work has to move to an offscreen document.`
    );
  }
}

/**
 * Landmarks for one face.
 *
 * Returns points in pixel coordinates for the image given, or null when no
 * face is found - a product shot cropped below the neck, or a photo where the
 * subject is turned away.
 */
export async function findFace(source) {
  const lm = await getLandmarker();
  const result = lm.detect(source);
  const face = result?.faceLandmarks?.[0];
  if (!face) return null;

  const w = source.width ?? source.naturalWidth ?? source.videoWidth;
  const h = source.height ?? source.naturalHeight ?? source.videoHeight;

  const points = face.map((p) => ({ x: p.x * w, y: p.y * h, z: p.z }));

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  return {
    points,
    box: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
    imageSize: { w, h },
  };
}

/** Is the head roughly facing the camera?
 *
 *  A warp between two faces only holds when both are near-frontal. Comparing
 *  the distance from each cheek to the nose gives a cheap yaw estimate: on a
 *  three-quarter turn one side is much shorter than the other, and the warp
 *  would smear rather than land.
 */
export function frontality({ points }) {
  const nose = points[1];
  const left = points[234];
  const right = points[454];
  if (!nose || !left || !right) return 0;

  const dl = Math.hypot(nose.x - left.x, nose.y - left.y);
  const dr = Math.hypot(nose.x - right.x, nose.y - right.y);
  const ratio = Math.min(dl, dr) / Math.max(dl, dr);
  return ratio; // 1.0 dead on, below ~0.6 is a strong turn
}
