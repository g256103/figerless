import { FilesetResolver, HandLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18";

export async function createHandTracker(mediapipeConfig, handConfig) {
  const vision = await FilesetResolver.forVisionTasks(mediapipeConfig.wasm);
  const handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: mediapipeConfig.model,
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: handConfig.numHands,
    minHandDetectionConfidence: handConfig.minHandDetectionConfidence,
    minHandPresenceConfidence: handConfig.minHandPresenceConfidence,
    minTrackingConfidence: handConfig.minTrackingConfidence,
  });

  let lastVideoTime = -1;

  return {
    detect(videoEl, timestampMs) {
      if (videoEl.readyState < 2) {
        return null;
      }
      if (videoEl.currentTime === lastVideoTime) {
        return null;
      }
      lastVideoTime = videoEl.currentTime;
      return handLandmarker.detectForVideo(videoEl, timestampMs);
    },
    close() {
      handLandmarker.close();
    },
  };
}
