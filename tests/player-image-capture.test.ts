import assert from "node:assert/strict";
import test, { before } from "node:test";
import { effectScope, ref, shallowRef, type Ref, type ShallowRef } from "vue";

import { CapturedMediaStore } from "../player/captured-media.js";
import {
  answerPlayerRuntimeImage,
  createPlayerRuntimeSession,
  playerRuntimeForeground,
  playerRuntimeMedia,
  type PlayerRuntimeSession,
} from "../player/runtime-adapter.js";
import { loadPlayerModule } from "./helpers/player-modules.js";

interface CaptureView {
  readonly phase: string;
  readonly question: string;
  readonly track: unknown;
  readonly photo: string | null;
  readonly countdown: number | null;
}
interface Capture {
  readonly view: Readonly<Ref<CaptureView | null>>;
  retry(): void;
  shutter(): Promise<void>;
  retake(): void;
  use(): void;
}
let useImageCapture: (host: unknown) => Capture;

// Load the real composable through the existing build tool: its browser-source imports use Vite resolution.
before(async () => {
  const module: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/useImageCapture.ts",
  );
  assert.equal(typeof module.useImageCapture, "function");
  // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its tested API.
  useImageCapture = module.useImageCapture as typeof useImageCapture;
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A camera as the capture uses it: available or not, a live track, the photos it stores, and its opening. */
class FakeCamera {
  available = false;
  readonly previewTrack = { kind: "video" };
  readonly taken: string[] = [];
  opened = 0;
  released = 0;
  /** When set, the next photo waits for it. */
  hold: Promise<void> | null = null;
  constructor(
    private readonly media: CapturedMediaStore,
    /** Each opening answers with the next outcome, as the browser would; then the camera opens. */
    private readonly opens: boolean[] = [],
  ) {}
  async open() {
    this.opened++;
    this.available = this.opens.shift() ?? true;
    return true;
  }
  release() {
    this.released++;
    this.available = false;
  }
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

function harness(
  source: string,
  {
    opens = [],
    sessionCameraOpen = false,
    offered = true,
    countdownStep = async () => {},
  }: {
    opens?: boolean[];
    sessionCameraOpen?: boolean;
    offered?: boolean;
    countdownStep?: () => Promise<void>;
  } = {},
) {
  const media = new CapturedMediaStore(null, { create: () => "blob:photo", revoke() {} }, "test");
  const sessionCamera = new FakeCamera(media);
  sessionCamera.available = sessionCameraOpen;
  // The capture's own camera, opened while the session camera is not open.
  const camera = new FakeCamera(media, opens);
  const session: ShallowRef<PlayerRuntimeSession | null> = shallowRef(
    createPlayerRuntimeSession(source),
  );
  const generation = ref(1);
  const cameraRevision = ref(0);
  // As in the Player, the capture lives in the session host's scope.
  const scope = effectScope();
  const capture = scope.run(() =>
    useImageCapture({
      session,
      generation,
      sessionCamera,
      captureCamera: camera,
      cameraRevision,
      media,
      offered,
      observe: () => session.value,
      publish: (next: PlayerRuntimeSession) => (session.value = next),
      countdownStep,
    }),
  )!;
  return { media, camera, sessionCamera, session, generation, cameraRevision, capture, scope };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const SELFIE = 'let pick = askImage("Smile for me", hint: "Attach a photo")\nshowImage pick\nexit';

test("the camera opens by itself with the request, and a photo answers only when it is used", async () => {
  const { media, camera, session, capture } = harness(SELFIE);
  assert.equal(capture.view.value?.phase, "opening");
  // The viewfinder shows the question, which the chat also shows; the hint only labels the composer.
  assert.equal(capture.view.value?.question, "Smile for me");
  await settled();
  assert.equal(capture.view.value?.phase, "live");
  assert.ok(capture.view.value?.track);
  await capture.shutter();
  assert.equal(capture.view.value?.phase, "review");
  assert.equal(capture.view.value?.photo, "blob:photo");
  // The request still waits while the player decides.
  assert.equal(playerRuntimeForeground(session.value!)?.kind, "ask-image");
  capture.retake();
  assert.equal(capture.view.value?.phase, "live");
  assert.equal(media.holds(camera.taken[0]!, "image"), false, "the photo taken again is dropped");
  await capture.shutter();
  capture.use();
  await settled();
  assert.equal(capture.view.value, null);
  assert.equal(camera.released, 1, "the camera the request opened turns off after the answer");
  assert.equal(session.value?.state.status, "halted");
  assert.equal(playerRuntimeMedia(session.value!.state).stage.image, camera.taken[1]);
  assert.equal(media.holds(camera.taken[1]!, "image"), true, "the used photo stays");
});

test("a file that answers the request turns the camera the request opened off", async () => {
  const { media, camera, session, capture } = harness(SELFIE);
  await settled();
  assert.equal(capture.view.value?.phase, "live");
  const file = media.add("image", new Blob([PNG], { type: "image/png" }), { width: 4, height: 3 });
  session.value = answerPlayerRuntimeImage(session.value!, file.reference, media)!.session;
  await settled();
  assert.equal(capture.view.value, null);
  assert.equal(camera.released, 1);
  assert.equal(camera.taken.length, 0);
});

test("a camera that cannot be used offers Try again", async () => {
  const { camera, capture } = harness(SELFIE, { opens: [false, true] });
  await settled();
  assert.equal(capture.view.value?.phase, "unavailable");
  assert.equal(capture.view.value?.track, null);
  capture.retry();
  assert.equal(capture.view.value?.phase, "opening");
  await settled();
  assert.equal(capture.view.value?.phase, "live");
  assert.equal(camera.opened, 2);
});

test("a restored or new session asks for the camera again but takes no photo, and drops the old one", async () => {
  const { media, camera, session, generation, capture } = harness(SELFIE);
  await settled();
  await capture.shutter();
  assert.equal(capture.view.value?.phase, "review");
  generation.value++;
  session.value = createPlayerRuntimeSession(SELFIE);
  await settled();
  assert.equal(media.holds(camera.taken[0]!, "image"), false);
  assert.equal(capture.view.value?.phase, "live");
  assert.equal(capture.view.value?.photo, null);
  assert.equal(camera.opened, 2);
  assert.equal(camera.taken.length, 1, "no photo is taken by itself");
});

test("a photo that arrives after its request was answered is dropped", async () => {
  const { media, camera, session, capture } = harness(SELFIE);
  await settled();
  let release!: () => void;
  camera.hold = new Promise((resolve) => (release = resolve));
  const shot = capture.shutter();
  // The countdown runs first; the photo is being taken once it ends.
  while (capture.view.value?.phase === "countdown") await settled();
  assert.equal(capture.view.value?.phase, "taking");
  const file = media.add("image", new Blob([PNG], { type: "image/png" }), { width: 4, height: 3 });
  session.value = answerPlayerRuntimeImage(session.value!, file.reference, media)!.session;
  await settled();
  release();
  await shot;
  assert.equal(capture.view.value, null);
  assert.equal(media.holds(camera.taken[0]!, "image"), false);
});

test("a request without a question shows the viewfinder's own question", async () => {
  const { capture } = harness('let pick = askImage(hint: "Attach a photo")\nexit');
  assert.equal(capture.view.value?.question, "Take a photo");
});

test("no capture opens for a request without the camera, or where no camera can be used", async () => {
  const withoutCamera = harness("let pick = askImage(allowCamera: false)\nexit");
  const unusable = harness(SELFIE, { offered: false });
  await settled();
  assert.equal(withoutCamera.capture.view.value, null);
  assert.equal(unusable.capture.view.value, null);
  assert.equal(withoutCamera.camera.opened + unusable.camera.opened, 0);
});

test("a capture uses the open session camera and leaves it on after the answer", async () => {
  const { camera, sessionCamera, session, capture } = harness(SELFIE, { sessionCameraOpen: true });
  await settled();
  assert.equal(capture.view.value?.phase, "live");
  await capture.shutter();
  capture.use();
  await settled();
  assert.equal(session.value?.state.status, "halted");
  assert.equal(sessionCamera.taken.length, 1);
  assert.deepEqual(
    [camera.opened, sessionCamera.opened, sessionCamera.released, sessionCamera.available],
    [0, 0, 0, true],
  );
});

test("the camera the request opens never opens the session camera", async () => {
  const { camera, sessionCamera, capture } = harness(SELFIE);
  await settled();
  assert.equal(capture.view.value?.phase, "live");
  assert.equal(camera.opened, 1);
  assert.equal(sessionCamera.available, false);
  assert.equal(sessionCamera.opened, 0);
});

test("a camera that ends while the player frames or reviews the photo offers Try again", async () => {
  const { camera, cameraRevision, capture } = harness(SELFIE);
  await settled();
  camera.available = false;
  cameraRevision.value++;
  await settled();
  assert.equal(capture.view.value?.phase, "unavailable");
  capture.retry();
  await settled();
  await capture.shutter();
  assert.equal(capture.view.value?.phase, "review");
  camera.available = false;
  cameraRevision.value++;
  capture.retake();
  assert.equal(capture.view.value?.phase, "unavailable");
});

test("unmounting the Player ends the capture: its photo is dropped and the camera it opened turns off", async () => {
  const { media, camera, capture, scope } = harness(SELFIE);
  await settled();
  await capture.shutter();
  assert.equal(capture.view.value?.phase, "review");
  scope.stop();
  assert.equal(camera.released, 1);
  assert.equal(media.holds(camera.taken[0]!, "image"), false);
});

test("the shutter counts down from five over the live camera before it takes the photo", async () => {
  const counts: (number | null)[] = [];
  let capture!: Capture;
  const harnessed = harness(SELFIE, {
    countdownStep: async () => {
      counts.push(capture.view.value?.countdown ?? null);
      assert.ok(capture.view.value?.track, "the live camera stays during the countdown");
    },
  });
  capture = harnessed.capture;
  await settled();
  await capture.shutter();
  assert.deepEqual(counts, [5, 4, 3, 2, 1]);
  assert.equal(capture.view.value?.phase, "review");
  assert.equal(capture.view.value?.countdown, null);
  assert.equal(harnessed.camera.taken.length, 1);
});

test("a request answered during the countdown takes no photo", async () => {
  let capture!: Capture;
  let answer!: () => void;
  const harnessed = harness(SELFIE, {
    countdownStep: async () => {
      if (capture.view.value?.countdown === 3) answer();
      await settled();
    },
  });
  capture = harnessed.capture;
  answer = () => {
    const file = harnessed.media.add("image", new Blob([PNG], { type: "image/png" }), {
      width: 4,
      height: 3,
    });
    harnessed.session.value = answerPlayerRuntimeImage(
      harnessed.session.value!,
      file.reference,
      harnessed.media,
    )!.session;
  };
  await settled();
  await capture.shutter();
  assert.equal(capture.view.value, null);
  assert.equal(harnessed.camera.taken.length, 0);
  assert.equal(harnessed.camera.released, 1);
});

test("unmounting the Player during the countdown counts no further and takes no photo", async () => {
  const counts: (number | null)[] = [];
  const harnessed = harness(SELFIE, {
    countdownStep: async () => {
      counts.push(harnessed.capture.view.value?.countdown ?? null);
      if (counts.length === 3) harnessed.scope.stop();
    },
  });
  await settled();
  await harnessed.capture.shutter();
  assert.deepEqual(counts, [5, 4, 3]);
  assert.equal(harnessed.camera.taken.length, 0);
  assert.equal(harnessed.camera.released, 1);
});
