import type {
  AudioSampler,
  CaptureDeviceInfo,
  CaptureHost,
  CaptureRecorder,
  CaptureRequest,
  CaptureSourceKind,
  CaptureSourceState,
} from "./capture-device.js";
import { RgbaImage } from "./rgba-image.js";
import type { SessionMediaUrls } from "./session-media.js";

/** Analysis window of the microphone sampler; 2048 samples are about 43 ms at 48 kHz. */
const AUDIO_WINDOW_SIZE = 2048;

/** The `CaptureHost` for real browsers: `getUserMedia`, `MediaRecorder`, canvas pixel access and Web Audio. */
export function createBrowserCaptureHost(
  stateChanged: (kind: CaptureSourceKind, state: CaptureSourceState) => void,
): CaptureHost<MediaStreamTrack> {
  return {
    async acquire(request) {
      const stream = await mediaDevices().getUserMedia(constraints(request));
      return stream.getTracks();
    },
    async listDevices() {
      const found: CaptureDeviceInfo[] = [];
      for (const device of await mediaDevices().enumerateDevices()) {
        if (device.kind === "videoinput")
          found.push({ kind: "camera", deviceId: device.deviceId, label: device.label });
        else if (device.kind === "audioinput")
          found.push({ kind: "microphone", deviceId: device.deviceId, label: device.label });
      }
      return found;
    },
    createRecorder(tracks) {
      return browserRecorder(new MediaRecorder(new MediaStream([...tracks])));
    },
    grabFrame,
    async encodeImage(image) {
      // PNG is lossless, so decoding the stored photo yields the captured pixels again.
      const canvas = createCanvas(image.width, image.height);
      context(canvas).putImageData(
        new ImageData(new Uint8ClampedArray(image.data), image.width, image.height),
        0,
        0,
      );
      return canvasBlob(canvas, "image/png");
    },
    async decodeImage(data) {
      const bitmap = await createImageBitmap(data);
      try {
        return drawPixels(bitmap, bitmap.width, bitmap.height);
      } finally {
        bitmap.close();
      }
    },
    createAudioSampler,
    now: () => performance.now(),
    stateChanged,
  };
}

export const browserMediaUrls: SessionMediaUrls = {
  create: (data) => URL.createObjectURL(data),
  revoke: (url) => URL.revokeObjectURL(url),
};

function mediaDevices(): MediaDevices {
  // Absent outside secure contexts and in browsers without capture support.
  if (!("mediaDevices" in navigator))
    throw new DOMException("Media capture is unavailable.", "NotSupportedError");
  return navigator.mediaDevices;
}

function constraints(request: CaptureRequest): MediaStreamConstraints {
  const result: MediaStreamConstraints = {};
  if (request.camera !== undefined) {
    const video: MediaTrackConstraints = {};
    if (request.camera.deviceId !== undefined) video.deviceId = { exact: request.camera.deviceId };
    if (request.camera.width !== undefined) video.width = { ideal: request.camera.width };
    if (request.camera.height !== undefined) video.height = { ideal: request.camera.height };
    result.video = video;
  }
  if (request.microphone !== undefined) {
    const audio: MediaTrackConstraints = {};
    if (request.microphone.deviceId !== undefined)
      audio.deviceId = { exact: request.microphone.deviceId };
    result.audio = audio;
  }
  return result;
}

function browserRecorder(recorder: MediaRecorder): CaptureRecorder {
  return {
    get mimeType() {
      return recorder.mimeType;
    },
    start(sink) {
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) sink.data(event.data);
      });
      recorder.addEventListener("stop", () => sink.stopped(), { once: true });
      recorder.addEventListener("error", (event) => sink.failed(event), { once: true });
      recorder.start();
    },
    stop() {
      if (recorder.state !== "inactive") recorder.stop();
    },
  };
}

/**
 * Copies the current frame through a temporary video element, which every browser with capture supports. The
 * element only consumes the track; stopping it does not stop the camera.
 */
async function grabFrame(track: MediaStreamTrack): Promise<RgbaImage> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  try {
    await video.play();
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA)
      await new Promise<void>((resolve, reject) => {
        video.addEventListener("loadeddata", () => resolve(), { once: true });
        video.addEventListener("error", () => reject(new DOMException("", "AbortError")), {
          once: true,
        });
      });
    if (video.videoWidth === 0 || video.videoHeight === 0)
      throw new DOMException("The camera delivered no frame.", "NotReadableError");
    return drawPixels(video, video.videoWidth, video.videoHeight);
  } finally {
    video.pause();
    video.srcObject = null;
  }
}

function drawPixels(source: CanvasImageSource, width: number, height: number): RgbaImage {
  const canvas = createCanvas(width, height);
  const drawing = context(canvas);
  drawing.drawImage(source, 0, 0, width, height);
  return new RgbaImage(width, height, drawing.getImageData(0, 0, width, height).data);
}

type Canvas = OffscreenCanvas | HTMLCanvasElement;

function createCanvas(width: number, height: number): Canvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function context(canvas: Canvas): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D {
  // Frequent reads are the purpose of this canvas, so keep its pixels in memory.
  const options: CanvasRenderingContext2DSettings = { willReadFrequently: true };
  const drawing =
    "toBlob" in canvas ? canvas.getContext("2d", options) : canvas.getContext("2d", options);
  if (drawing === null) throw new DOMException("No 2D canvas is available.", "NotSupportedError");
  return drawing;
}

function canvasBlob(canvas: Canvas, type: string): Promise<Blob> {
  if (!("toBlob" in canvas)) return canvas.convertToBlob({ type });
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob === null ? reject(new DOMException("", "EncodingError")) : resolve(blob)),
      type,
    ),
  );
}

function createAudioSampler(track: MediaStreamTrack): AudioSampler {
  const audio = new AudioContext();
  const source = audio.createMediaStreamSource(new MediaStream([track]));
  const analyser = audio.createAnalyser();
  analyser.fftSize = AUDIO_WINDOW_SIZE;
  // Analysis only: the analyser is not connected to the speakers, so the microphone is never played back.
  source.connect(analyser);
  // A context created without user activation may start suspended; analysis then reads silence until it resumes.
  void audio.resume().catch(() => {});
  return {
    sampleRate: audio.sampleRate,
    windowSize: AUDIO_WINDOW_SIZE,
    readTimeDomain: (target) => analyser.getFloatTimeDomainData(target),
    readFrequency: (target) => analyser.getFloatFrequencyData(target),
    close() {
      source.disconnect();
      void audio.close().catch(() => {});
    },
  };
}
