import assert from "node:assert/strict";
import test, { before } from "node:test";
import { effectScope, ref, shallowRef, type Ref, type ShallowRef } from "vue";

import { CapturedMediaStore } from "../player/captured-media.js";
import {
  answerPlayerRuntimeImage,
  createPlayerRuntimeSession,
  playerRuntimeForeground,
  playerRuntimeMedia,
  type PlayerRuntimeControlResult,
  type PlayerRuntimeSession,
} from "../player/runtime-adapter.js";
import { loadPlayerModule } from "./helpers/player-modules.js";

interface CaptureView {
  readonly phase: string;
  readonly camera: boolean;
  readonly track: unknown;
  readonly ready: boolean;
  readonly preview: string | null;
  readonly countdown: number | null;
}
interface Capture {
  readonly view: Readonly<Ref<CaptureView | null>>;
  openCamera(): void;
  retry(): void;
  back(): void;
  takePhoto(): Promise<void>;
  selfTimer(): Promise<void>;
  choose(reference: string): boolean;
  use(session: PlayerRuntimeSession): PlayerRuntimeControlResult | null;
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
  // The camera step's own camera, opened while the session camera is not open.
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
      countdownStep,
    }),
  )!;
  /** A file the player chose, stored as the Player stores it. */
  const file = () =>
    media.add("image", new Blob([PNG], { type: "image/png" }), { width: 4, height: 3 }).reference;
  /** "Use image", as the Player's interaction answers at the observed time. */
  const use = () => {
    const result = capture.use(session.value!);
    if (result?.outcome.kind === "completed") session.value = result.session;
    return result;
  };
  return {
    media,
    camera,
    sessionCamera,
    session,
    generation,
    cameraRevision,
    capture,
    scope,
    file,
    use,
  };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const SELFIE = 'let pick = askImage("Smile for me", hint: "Attach a photo")\nshowImage pick\nexit';

test("a request starts at the first step; Open camera leads to the camera, whose photo becomes the preview", async () => {
  const { media, camera, session, capture, use } = harness(SELFIE);
  assert.deepEqual(capture.view.value, {
    phase: "choose",
    camera: true,
    track: null,
    ready: false,
    preview: null,
    countdown: null,
  });
  assert.equal(camera.opened, 0, "the camera does not turn on by itself");
  assert.equal(use(), null, "without an image there is nothing to use");
  capture.openCamera();
  assert.equal(capture.view.value?.phase, "opening");
  await settled();
  assert.equal(capture.view.value?.phase, "live");
  assert.ok(capture.view.value?.track);
  await capture.takePhoto();
  // The photo is taken at once and the first step shows it, with the camera the request opened off again.
  assert.equal(capture.view.value?.phase, "choose");
  assert.equal(capture.view.value?.ready, true);
  assert.equal(capture.view.value?.preview, "blob:photo");
  assert.equal(capture.view.value?.track, null);
  assert.equal(camera.released, 1);
  assert.equal(
    playerRuntimeForeground(session.value!)?.kind,
    "ask-image",
    "the request still waits",
  );
  assert.equal(use()?.outcome.kind, "completed");
  await settled();
  assert.equal(capture.view.value, null);
  assert.equal(session.value?.state.status, "halted");
  assert.equal(playerRuntimeMedia(session.value!.state).stage.image, camera.taken[0]);
  assert.equal(media.holds(camera.taken[0]!, "image"), true, "the used photo stays");
});

test("a file chosen at either step becomes the preview, and each new image replaces the last", async () => {
  const { media, camera, session, capture, file, use } = harness(SELFIE);
  const first = file();
  assert.equal(capture.choose(first), true);
  assert.equal(capture.view.value?.phase, "choose");
  assert.equal(capture.view.value?.ready, true);
  capture.openCamera();
  await settled();
  await capture.takePhoto();
  assert.equal(media.holds(first, "image"), false, "the photo replaced the file");
  capture.openCamera();
  await settled();
  // A file given during the camera step returns to the first step and turns the camera off.
  const second = file();
  assert.equal(capture.choose(second), true);
  assert.deepEqual(
    [capture.view.value?.phase, camera.released, media.holds(camera.taken[0]!, "image")],
    ["choose", 2, false],
  );
  use();
  assert.equal(playerRuntimeMedia(session.value!.state).stage.image, second);
});

test("Back returns to the first step without a new photo and keeps the preview", async () => {
  const { media, camera, capture } = harness(SELFIE);
  capture.openCamera();
  await settled();
  await capture.takePhoto();
  capture.openCamera();
  await settled();
  capture.back();
  assert.deepEqual(
    [capture.view.value?.phase, capture.view.value?.ready, camera.released, camera.taken.length],
    ["choose", true, 2, 1],
  );
  assert.equal(media.holds(camera.taken[0]!, "image"), true);
});

test("the self-timer counts down from five over the live camera, then takes the photo", async () => {
  const counts: (number | null)[] = [];
  let capture!: Capture;
  const harnessed = harness(SELFIE, {
    countdownStep: async () => {
      counts.push(capture.view.value?.countdown ?? null);
      assert.ok(capture.view.value?.track, "the live camera stays during the countdown");
    },
  });
  capture = harnessed.capture;
  capture.openCamera();
  await settled();
  await capture.selfTimer();
  assert.deepEqual(counts, [5, 4, 3, 2, 1]);
  assert.equal(capture.view.value?.phase, "choose");
  assert.equal(capture.view.value?.countdown, null);
  assert.equal(harnessed.camera.taken.length, 1);
});

test("Back during the countdown takes no photo", async () => {
  let capture!: Capture;
  const harnessed = harness(SELFIE, {
    countdownStep: async () => {
      if (capture.view.value?.countdown === 3) capture.back();
      await settled();
    },
  });
  capture = harnessed.capture;
  capture.openCamera();
  await settled();
  await capture.selfTimer();
  assert.deepEqual([capture.view.value?.phase, capture.view.value?.ready], ["choose", false]);
  assert.equal(harnessed.camera.taken.length, 0);
});

test("a camera that cannot be used offers Try again", async () => {
  const { camera, capture } = harness(SELFIE, { opens: [false, true] });
  capture.openCamera();
  await settled();
  assert.equal(capture.view.value?.phase, "unavailable");
  assert.equal(capture.view.value?.track, null);
  capture.retry();
  assert.equal(capture.view.value?.phase, "opening");
  await settled();
  assert.equal(capture.view.value?.phase, "live");
  assert.equal(camera.opened, 2);
});

test("a restored or new session starts at the first step without the preview and takes no photo", async () => {
  const { media, camera, session, generation, capture } = harness(SELFIE);
  capture.openCamera();
  await settled();
  await capture.takePhoto();
  capture.openCamera();
  await settled();
  generation.value++;
  session.value = createPlayerRuntimeSession(SELFIE);
  await settled();
  assert.equal(media.holds(camera.taken[0]!, "image"), false);
  assert.deepEqual([capture.view.value?.phase, capture.view.value?.ready], ["choose", false]);
  assert.deepEqual([camera.opened, camera.released, camera.taken.length], [2, 2, 1]);
});

test("a request answered otherwise closes its steps and drops the preview, also a photo still being taken", async () => {
  const { media, camera, session, capture, file } = harness(SELFIE);
  capture.openCamera();
  await settled();
  await capture.takePhoto();
  capture.openCamera();
  await settled();
  let release!: () => void;
  camera.hold = new Promise((resolve) => (release = resolve));
  const shot = capture.takePhoto();
  assert.equal(capture.view.value?.phase, "taking");
  session.value = answerPlayerRuntimeImage(session.value!, file(), media)!.session;
  await settled();
  release();
  await shot;
  assert.equal(capture.view.value, null);
  assert.equal(camera.released, 2, "the camera the request opened turns off");
  assert.equal(media.holds(camera.taken[0]!, "image"), false);
  assert.equal(media.holds(camera.taken[1]!, "image"), false);
});

test("a request without the camera, or where no camera can be used, offers none", async () => {
  const withoutCamera = harness("let pick = askImage(allowCamera: false)\nexit");
  const unusable = harness(SELFIE, { offered: false });
  for (const { capture, camera } of [withoutCamera, unusable]) {
    assert.deepEqual([capture.view.value?.phase, capture.view.value?.camera], ["choose", false]);
    capture.openCamera();
    await settled();
    assert.deepEqual([capture.view.value?.phase, camera.opened], ["choose", 0]);
  }
});

test("the camera step uses the open session camera and leaves it on", async () => {
  const { camera, sessionCamera, session, capture, use } = harness(SELFIE, {
    sessionCameraOpen: true,
  });
  capture.openCamera();
  assert.equal(capture.view.value?.phase, "live");
  await capture.takePhoto();
  capture.openCamera();
  capture.back();
  use();
  assert.equal(session.value?.state.status, "halted");
  assert.equal(sessionCamera.taken.length, 1);
  assert.deepEqual(
    [camera.opened, sessionCamera.opened, sessionCamera.released, sessionCamera.available],
    [0, 0, 0, true],
  );
});

test("a camera that ends while the player frames the photo offers Try again", async () => {
  const { camera, cameraRevision, capture } = harness(SELFIE);
  capture.openCamera();
  await settled();
  camera.available = false;
  cameraRevision.value++;
  await settled();
  assert.equal(capture.view.value?.phase, "unavailable");
});

test("unmounting the Player drops the preview and turns the camera it opened off", async () => {
  const { media, camera, capture, scope } = harness(SELFIE);
  capture.openCamera();
  await settled();
  await capture.takePhoto();
  capture.openCamera();
  await settled();
  scope.stop();
  assert.equal(camera.released, 2);
  assert.equal(media.holds(camera.taken[0]!, "image"), false);
});

test("unmounting the Player during the countdown counts no further and takes no photo", async () => {
  const counts: (number | null)[] = [];
  const harnessed = harness(SELFIE, {
    countdownStep: async () => {
      counts.push(harnessed.capture.view.value?.countdown ?? null);
      if (counts.length === 3) harnessed.scope.stop();
    },
  });
  harnessed.capture.openCamera();
  await settled();
  await harnessed.capture.selfTimer();
  assert.deepEqual(counts, [5, 4, 3]);
  assert.equal(harnessed.camera.taken.length, 0);
  assert.equal(harnessed.camera.released, 1);
});
