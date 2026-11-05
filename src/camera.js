export async function startCamera(videoEl, constraints) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("このブラウザはカメラ API に対応していません。");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: constraints.facingMode,
      width: { ideal: constraints.width },
      height: { ideal: constraints.height },
    },
  });

  videoEl.srcObject = stream;
  await videoEl.play();

  return stream;
}

export function stopCamera(videoEl, stream) {
  if (stream) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }
  if (videoEl) {
    videoEl.srcObject = null;
  }
}
