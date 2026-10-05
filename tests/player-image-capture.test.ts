import assert from "node:assert/strict";
import test, { before } from "node:test";
import { ref, shallowRef, type Ref, type ShallowRef } from "vue";
import { createServer } from "vite";

import { CapturedMediaStore } from "../player/captured-media.js";
import {
  createPlayerRuntimeSession,
  playerRuntimeForeground,
  playerRuntimeMedia,
  type PlayerRuntimeSession,
} from "../player/runtime-adapter.js";

interface CaptureView {
  readonly phase: string;
  readonly question: string;
  readonly track: unknown;
  readonly photo: string | null;
}
interface Capture {
  readonly view: Readonly<Ref<CaptureView | null>>;
  open(): void;
  retry(): void;
  shutter(): Promise<void>;
  retake(): void;
  use(): void;
  close(): void;
}
let useImageCapture: (host: unknown) => Capture;

// Load the real composable through the existing build tool: its browser-source imports use Vite resolution.
before(async () => {
  const server = await createServer({
    configFile: false,
    logLevel: "warn",
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const module: Record<string, unknown> = await server.ssrLoadModule(
      "/player/vue/src/useImageCapture.ts",
    );
    assert.equal(typeof module.useImageCapture, "function");
    // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its tested API.
    useImageCapture = module.useImageCapture as typeof useImageCapture;
  } finally {
    await server.close();
  }
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The session camera as the capture uses it: available or not, a live track, and the photos it stores. */
class FakeCamera {
  available = false;
  readonly previewTrack = { kind: "video" };
  readonly taken: string[] = [];
  /** When set, the next photo waits for it. */
  hold: Promise<void> | null = null;
  constructor(private readonly media: CapturedMediaStore) {}
  async answer() {
    if (this.hold) await this.hold;
    if (!this.available) return { kind: "unavailable", reason: "failed" } as const;
    const photo = this.media.add("image", new Blob([PNG], { type: "image/png" }), {
      width: 4,
      height: 3,
    });
    this.taken.push(photo.reference);
    return { kind: "captured", reference: photo.reference } as const;
  }
}

function harness(source: string, opens: boolean[] = []) {
  const media = new CapturedMediaStore(null, { create: () => "blob:photo", revoke() {} }, "test");
  const camera = new FakeCamera(media);
  const session: ShallowRef<PlayerRuntimeSession | null> = shallowRef(
    createPlayerRuntimeSession(source),
  );
  const generation = ref(1);
  let ended = 0;
  const capture = useImageCapture({
    session,
    generation,
    camera,
    cameraRevision: ref(0),
    media,
    // Each opening answers with the next outcome, as the browser would; then the camera opens.
    openCamera: async () => {
      camera.available = opens.shift() ?? true;
      return true;
    },
    captureEnded: () => ended++,
    observe: () => session.value,
    publish: (next: PlayerRuntimeSession) => (session.value = next),
  });
  return { media, camera, session, generation, capture, ended: () => ended };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const SELFIE = 'let pick = askImage("Smile for me")\nshowImage pick\nexit';

test("a photo answers the request only when it is used, and one taken again replaces it", async () => {
  const { media, camera, session, capture, ended } = harness(SELFIE);
  capture.open();
  assert.equal(capture.view.value?.phase, "opening");
  assert.equal(capture.view.value?.question, "Smile for me");
  await settled();
  assert.equal(capture.view.value?.phase, "live");
  assert.ok(capture.view.value?.track);
  await capture.shutter();
  assert.equal(capture.view.value?.phase, "review");
  assert.equal(capture.view.value?.photo, "blob:photo");
  assert.equal(capture.view.value?.track, null);
  // The request still waits while the player decides.
  assert.equal(playerRuntimeForeground(session.value!)?.kind, "ask-image");
  capture.retake();
  assert.equal(capture.view.value?.phase, "live");
  assert.equal(media.holds(camera.taken[0]!, "image"), false, "the photo taken again is dropped");
  await capture.shutter();
  capture.use();
  assert.equal(capture.view.value, null);
  assert.equal(ended(), 1);
  assert.equal(session.value?.snapshot.status, "halted");
  assert.equal(playerRuntimeMedia(session.value!.snapshot).stage.image, camera.taken[1]);
  assert.equal(media.holds(camera.taken[1]!, "image"), true, "the used photo stays");
});

test("a camera that cannot be used offers Try again, and closing leaves the request waiting", async () => {
  const { session, capture, ended } = harness(SELFIE, [false, true]);
  capture.open();
  await settled();
  assert.equal(capture.view.value?.phase, "unavailable");
  assert.equal(capture.view.value?.track, null);
  capture.retry();
  assert.equal(capture.view.value?.phase, "opening");
  await settled();
  assert.equal(capture.view.value?.phase, "live");
  capture.close();
  assert.equal(capture.view.value, null);
  assert.equal(ended(), 1);
  assert.equal(playerRuntimeForeground(session.value!)?.kind, "ask-image");
});

test("a capture closes when its request ends or its session is replaced, and drops its photo", async () => {
  const { media, camera, session, generation, capture } = harness(SELFIE);
  capture.open();
  await settled();
  await capture.shutter();
  assert.equal(capture.view.value?.phase, "review");
  // A new session, as after a restore or a new Start: the capture is never carried over.
  generation.value++;
  session.value = createPlayerRuntimeSession(SELFIE);
  await settled();
  assert.equal(capture.view.value, null);
  assert.equal(media.holds(camera.taken[0]!, "image"), false);
});

test("a photo that arrives after its capture closed is dropped", async () => {
  const { media, camera, capture } = harness(SELFIE);
  capture.open();
  await settled();
  let release!: () => void;
  camera.hold = new Promise((resolve) => (release = resolve));
  const shot = capture.shutter();
  assert.equal(capture.view.value?.phase, "taking");
  capture.close();
  release();
  await shot;
  assert.equal(capture.view.value, null);
  assert.equal(media.holds(camera.taken[0]!, "image"), false);
});

test("only a request that allows the camera opens a capture", async () => {
  const { capture } = harness("let pick = askImage(allowCamera: false)\nexit");
  capture.open();
  assert.equal(capture.view.value, null);
});
