import assert from "node:assert/strict";
import test from "node:test";

import {
  CaptureDevice,
  type CaptureHost,
  type CaptureRequest,
  type CaptureTrack,
} from "../player/capture-device.js";
import { nextCamera } from "../player/camera-choice.js";
import { CapturedMediaStore } from "../player/captured-media.js";
import { RgbaImage } from "../player/rgba-image.js";
import {
  createPlayerRuntimeSession,
  type PlayerCaptureAnswer,
  type PlayerRuntimeSession,
  playerRuntimeSnapshot,
} from "../player/runtime-adapter.js";
import { CaptureService, SessionCamera, type PlayerDiagnostic } from "../player/session-camera.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));

class FakeTrack implements CaptureTrack {
  readonly kind = "video";
  readonly label = "camera";
  readyState: "live" | "ended" = "live";
  muted = false;
  readonly #listeners: Record<"ended" | "mute", Array<() => void>> = { ended: [], mute: [] };
  stop() {
    this.readyState = "ended";
  }
  addEventListener(type: "ended" | "mute", listener: () => void) {
    this.#listeners[type].push(listener);
  }
  /** The browser or the system ends the stream. */
  end() {
    this.readyState = "ended";
    for (const listener of this.#listeners.ended) listener();
  }
  /** The stream stops delivering frames, as a phone's camera while the page is in the background. */
  mute() {
    this.muted = true;
    for (const listener of this.#listeners.mute) listener();
  }
}

function harness(
  grant: (request: CaptureRequest) => Promise<readonly FakeTrack[]>,
  chosen: () => string | null = () => null,
) {
  // Whether the page is shown, and the clock that tells trouble that keeps coming back; waits pass at once.
  const page = { shown: true, now: 0 };
  const requests: CaptureRequest[] = [];
  const diagnostics: PlayerDiagnostic[] = [];
  const grabbed: FakeTrack[] = [];
  const frames = { fail: false, grabbed };
  const host: CaptureHost<FakeTrack> = {
    acquire: (request) => (requests.push(request), grant(request)),
    listDevices: async () => [],
    createRecorder: () => {
      throw new Error("not used");
    },
    grabFrame: async (track) => {
      if (frames.fail) throw Object.assign(new Error(), { name: "NotReadableError" });
      frames.grabbed.push(track);
      return new RgbaImage(1, 1, new Uint8ClampedArray([1, 2, 3, 255]));
    },
    encodeImage: async () => new Blob(["png"], { type: "image/png" }),
    decodeImage: async () => new RgbaImage(1, 1, new Uint8ClampedArray(4)),
    createAudioSampler: () => {
      throw new Error("not used");
    },
    now: () => 0,
    stateChanged: (kind, state) => {
      if (kind === "camera" && state.status === "ended") camera.ended();
    },
  };
  const media = new CapturedMediaStore(
    null,
    { create: () => "blob:", revoke: () => {} },
    "package",
  );
  const device = new CaptureDevice(host, media);
  const camera: SessionCamera<FakeTrack> = new SessionCamera(
    device,
    (diagnostic) => diagnostics.push(diagnostic),
    { chosen, visible: () => page.shown, wait: async () => {}, now: () => page.now },
  );
  return { camera, device, media, requests, diagnostics, frames, page };
}

/** A grant that opens a new camera track for every request, recorded in `opened`. */
function newTracks(opened: FakeTrack[]) {
  return async () => {
    const track = new FakeTrack();
    opened.push(track);
    return [track];
  };
}

test("the session camera opens once and captures silently from the open stream", async () => {
  const track = new FakeTrack();
  const { camera, media, requests } = harness(async () => [track]);
  assert.equal(await camera.open(true), true);
  const first = await camera.answer();
  const second = await camera.answer();
  assert.equal(first.kind, "captured");
  assert.equal(second.kind, "captured");
  assert.ok(first.kind === "captured" && media.holds(first.reference, "image"));
  // Capturing never opens or reopens the camera, and keeps it open.
  assert.equal(requests.length, 1);
  assert.equal(track.readyState, "live");
  // Continuing the session on the same page keeps the open camera.
  await camera.open(true);
  assert.equal(requests.length, 1);
});

test("without the capability, or when the camera cannot be opened, captures answer unavailable", async () => {
  const unconfigured = harness(async () => [new FakeTrack()]);
  await unconfigured.camera.open(false);
  assert.deepEqual(await unconfigured.camera.answer(), {
    kind: "unavailable",
    reason: "unconfigured",
  });
  assert.equal(unconfigured.requests.length, 0);

  const denied = harness(async () => {
    throw Object.assign(new Error("Permission denied by user"), { name: "NotAllowedError" });
  });
  assert.equal(await denied.camera.open(true), true);
  assert.deepEqual(await denied.camera.answer(), { kind: "unavailable", reason: "denied" });
  // No second permission request later in the session.
  assert.deepEqual(await denied.camera.answer(), { kind: "unavailable", reason: "denied" });
  assert.equal(denied.requests.length, 1);
  assert.deepEqual(denied.diagnostics, [
    {
      code: "camera-denied",
      message:
        "The session camera could not be opened (denied, NotAllowedError); it stays unavailable for this session.",
    },
  ]);
});

test("a camera that cannot capture stays unavailable for the rest of the session", async () => {
  const failing = harness(async () => [new FakeTrack()]);
  await failing.camera.open(true);
  failing.frames.fail = true;
  // The camera is open, so a frame that cannot be copied is a capture failure, not a busy device.
  assert.deepEqual(await failing.camera.answer(), { kind: "unavailable", reason: "failed" });
  failing.frames.fail = false;
  assert.deepEqual(await failing.camera.answer(), { kind: "unavailable", reason: "failed" });
  assert.equal(failing.device.state("camera").status, "idle");
  assert.match(
    failing.diagnostics[0]?.message ?? "",
    /could not capture a photo \(failed, \w+Error\)/,
  );
});

test("the viewfinder previews only the open camera's live track", async () => {
  const track = new FakeTrack();
  const open = harness(async () => [track]);
  assert.equal(open.camera.previewTrack, null);
  await open.camera.open(true);
  assert.equal(open.camera.previewTrack, track);
  // Taking a photo uses the same stream and keeps the preview.
  assert.equal((await open.camera.answer()).kind, "captured");
  assert.equal(open.camera.previewTrack, track);

  const denied = harness(async () => {
    throw Object.assign(new Error(), { name: "NotAllowedError" });
  });
  await denied.camera.open(true);
  assert.equal(denied.camera.previewTrack, null);

  const failing = harness(async () => [new FakeTrack()]);
  await failing.camera.open(true);
  failing.frames.fail = true;
  await failing.camera.answer();
  assert.equal(failing.camera.previewTrack, null);

  const released = harness(async () => [new FakeTrack()]);
  await released.camera.open(true);
  released.camera.release();
  assert.equal(released.camera.previewTrack, null);
});

test("the player switches the open camera, and a photo taken meanwhile comes from the next camera", async () => {
  const opened: FakeTrack[] = [];
  const pending: Array<() => void> = [];
  let chosen: string | null = "back";
  const { camera, requests, frames } = harness(
    () =>
      new Promise((resolve) => {
        const track = new FakeTrack();
        opened.push(track);
        // The first camera opens at once; a switch waits until the test lets it open.
        if (opened.length === 1) resolve([track]);
        else pending.push(() => resolve([track]));
      }),
    () => chosen,
  );
  // The camera the player chose opens.
  await camera.open(true);
  assert.deepEqual(requests[0], { camera: { deviceId: "back" } });
  const [first] = opened;
  const switching = camera.switchTo("front");
  await settle();
  assert.deepEqual(requests[1], { camera: { deviceId: "front" } });
  // Phones open one camera at a time: the previous camera closed, and the view keeps its picture until the next arrives.
  assert.equal(first?.readyState, "ended");
  assert.equal(camera.previewTrack, first);
  const photo = camera.answer();
  pending.shift()?.();
  assert.equal(await switching, true);
  assert.equal((await photo).kind, "captured");
  assert.equal(frames.grabbed[0], opened[1]);
  assert.equal(camera.previewTrack, opened[1]);

  // A camera that cannot be opened opens the chosen camera again, and the session camera stays open. A chosen camera
  // the browser no longer has opens the default camera.
  chosen = "front";
  const failing = harness(
    async (request) => {
      if (request.camera?.deviceId === "gone")
        throw Object.assign(new Error(), { name: "OverconstrainedError" });
      return [new FakeTrack()];
    },
    () => chosen,
  );
  await failing.camera.open(true);
  assert.equal(await failing.camera.switchTo("gone"), false);
  assert.deepEqual(failing.requests.at(-1), { camera: { deviceId: "front" } });
  assert.equal(failing.camera.available, true);
  assert.equal((await failing.camera.answer()).kind, "captured");
  failing.camera.release();
  chosen = "gone";
  await failing.camera.open(true);
  assert.deepEqual(failing.requests.slice(-2), [{ camera: { deviceId: "gone" } }, { camera: {} }]);
  assert.equal(failing.camera.available, true);
  assert.deepEqual(failing.diagnostics, []);

  // The switch steps through the browser's cameras in its order and wraps around; one camera has nothing to switch to.
  const cameras = [{ deviceId: "front" }, { deviceId: "back" }, { deviceId: "wide" }];
  assert.equal(nextCamera(cameras, "back")?.deviceId, "wide");
  assert.equal(nextCamera(cameras, "wide")?.deviceId, "front");
  assert.equal(nextCamera(cameras.slice(0, 1), "front"), null);
});

test("a camera whose stream ended or stopped opens again with the same camera, and a photo waits for it", async () => {
  const opened: FakeTrack[] = [];
  const { camera, requests, frames, page, diagnostics } = harness(newTracks(opened), () => "back");
  await camera.open(true);
  const [first] = opened;
  first?.end();
  // The view keeps the ended camera's picture until the reopened camera's arrives.
  assert.equal(camera.previewTrack, first);
  assert.equal((await camera.answer()).kind, "captured");
  assert.equal(frames.grabbed.at(-1), opened[1]);
  assert.equal(camera.previewTrack, opened[1]);
  assert.deepEqual(requests.slice(-1), [{ camera: { deviceId: "back" } }]);

  // A muted camera that does not resume opens again, and a photo taken meanwhile comes from the reopened camera.
  opened[1]?.mute();
  assert.equal((await camera.answer()).kind, "captured");
  assert.equal(frames.grabbed.at(-1), opened[2]);

  // A hidden page cannot get the camera back: no photo for now, and the camera opens again once the page is shown.
  page.shown = false;
  page.now += 60_000;
  opened[2]?.end();
  assert.deepEqual(await camera.answer(), { kind: "unavailable", reason: "revoked" });
  assert.equal(camera.available, true);
  assert.equal(opened.length, 3);
  page.shown = true;
  camera.shown();
  await settle();
  assert.equal(camera.previewTrack, opened[3]);
  assert.equal((await camera.answer()).kind, "captured");
  // Each return to the page may find the camera stopped again; that never uses up the recoveries.
  for (let visit = 0; visit < 4; visit++) {
    page.shown = false;
    opened.at(-1)?.end();
    page.shown = true;
    camera.shown();
    await settle();
  }
  assert.equal(opened.length, 8);
  // Also a stream that ended without telling, found once the page is shown again.
  opened[7]?.stop();
  camera.shown();
  await settle();
  assert.equal(opened.length, 9);
  assert.equal((await camera.answer()).kind, "captured");
  assert.deepEqual(diagnostics, []);
});

test("a camera that is refused, cannot be opened again, or keeps stopping stops opening again", async () => {
  // A refusal is not asked again.
  let refuse = false;
  const refused = harness(async () => {
    if (refuse) throw Object.assign(new Error(), { name: "NotAllowedError" });
    return [new FakeTrack()];
  });
  await refused.camera.open(true);
  refuse = true;
  refused.camera.stalled();
  assert.deepEqual(await refused.camera.answer(), { kind: "unavailable", reason: "denied" });
  assert.equal(refused.requests.length, 2);
  assert.match(
    refused.diagnostics[0]?.message ?? "",
    /could not be opened again \(denied, NotAllowedError\)/,
  );

  // A busy camera is tried a few times, waiting longer each time.
  let busy = false;
  const failing = harness(async () => {
    if (busy) throw Object.assign(new Error(), { name: "NotReadableError" });
    return [new FakeTrack()];
  });
  await failing.camera.open(true);
  busy = true;
  failing.camera.stalled();
  assert.deepEqual(await failing.camera.answer(), { kind: "unavailable", reason: "busy" });
  assert.equal(failing.requests.length, 4);

  // A camera that stops again right after each recovery stays unavailable after a few of them.
  const opened: FakeTrack[] = [];
  const stopping = harness(newTracks(opened));
  await stopping.camera.open(true);
  for (let recovery = 0; recovery < 3; recovery++) {
    opened.at(-1)?.end();
    await settle();
  }
  assert.equal(opened.length, 4);
  opened.at(-1)?.end();
  assert.equal(opened.length, 4);
  assert.equal(stopping.camera.available, false);
  assert.match(stopping.diagnostics[0]?.message ?? "", /kept stopping/);
});

test("a session released while the browser answers never reports its camera as opened", async () => {
  let grant = (_tracks: readonly FakeTrack[]) => {};
  const track = new FakeTrack();
  const { camera } = harness(() => new Promise((resolve) => (grant = resolve)));
  const opening = camera.open(true);
  camera.release();
  grant([track]);
  assert.equal(await opening, false);
  assert.equal(track.readyState, "ended");
  assert.equal(camera.available, false);
});

function serviceHarness(answer: () => Promise<PlayerCaptureAnswer>) {
  const state: { session: PlayerRuntimeSession | null; generation: number } = {
    session: null,
    generation: 0,
  };
  const diagnostics: PlayerDiagnostic[] = [];
  const held = new Set<string>();
  const service = new CaptureService(answer, {
    session: () => state.session,
    generation: () => state.generation,
    observe: () => state.session,
    publish: (next) => (state.session = next),
    capturedMedia: { holds: (reference, kind) => kind === "image" && held.has(reference) },
    diagnostic: (diagnostic) => diagnostics.push(diagnostic),
    later: (task) => setImmediate(task),
  });
  const start = (source: string) => {
    state.generation++;
    state.session = createPlayerRuntimeSession(source);
  };
  return { state, service, diagnostics, held, start };
}

test("a capture is answered once and its photo continues the script", async () => {
  let answers = 0;
  const harness = serviceHarness(async () => {
    answers++;
    return { kind: "captured", reference: `photo-${answers}` };
  });
  harness.held.add("photo-1");
  harness.start("let photo = takePhoto()\nshowImage photo\nexit");
  harness.service.request();
  await settle();
  assert.equal(answers, 1);
  assert.equal(harness.state.session?.state.status, "halted");
  assert.equal(playerRuntimeSnapshot(harness.state.session!).stageImage, "photo-1");
});

test("a session replaced while its photo is captured gets its own capture serviced", async () => {
  const answers: Array<(answer: PlayerCaptureAnswer) => void> = [];
  const harness = serviceHarness(() => new Promise((resolve) => answers.push(resolve)));
  harness.start("let photo = takePhoto()\nshowImage photo\nexit");
  harness.service.request();
  await settle();
  // Action IDs restart, so the successor's capture has the same ID as the replaced one.
  harness.start("let photo = takePhoto()\nshowImage photo\nexit");
  harness.held.add("old photo");
  answers[0]?.({ kind: "captured", reference: "old photo" });
  await settle();
  await settle();
  assert.equal(answers.length, 2);
  assert.equal(harness.state.session?.state.foregroundAction?.kind, "capture");
  harness.held.add("new photo");
  answers[1]?.({ kind: "captured", reference: "new photo" });
  await settle();
  await settle();
  assert.equal(playerRuntimeSnapshot(harness.state.session!).stageImage, "new photo");
});

test("a captured reference the store does not hold never leaves the script waiting", async () => {
  const harness = serviceHarness(async () => ({ kind: "captured", reference: "unknown" }));
  harness.start("let photo = takePhoto()\nlet missing = photo == null\nexit");
  harness.service.request();
  await settle();
  assert.equal(harness.state.session?.state.status, "halted");
  assert.equal(harness.diagnostics[0]?.code, "capture-rejected");
});

test("a script capturing in a loop still lets other tasks run between captures", async () => {
  let otherTaskRan = false;
  let answers = 0;
  let starved = false;
  const harness = serviceHarness(async () => {
    // Without yielding, captures keep coming without the other task ever running; stop instead of hanging.
    if (++answers > 50 && !otherTaskRan) {
      starved = true;
      harness.service.stop();
    }
    return { kind: "unavailable", reason: "denied" };
  });
  harness.start("repeat 1000 {\n  takePhoto()\n}\nexit");
  setTimeout(() => (otherTaskRan = true), 0);
  harness.service.request();
  for (let turn = 0; turn < 20 && !otherTaskRan && !starved; turn++) await settle();
  harness.service.stop();
  assert.equal(starved, false);
  assert.equal(otherTaskRan, true);
});

test("a stopped service never resumes the script with an answer still in flight", async () => {
  let deliver = (_answer: PlayerCaptureAnswer) => {};
  const harness = serviceHarness(() => new Promise((resolve) => (deliver = resolve)));
  harness.start("let photo = takePhoto()\nlet continued = true\nexit");
  harness.service.request();
  await settle();
  harness.service.stop();
  deliver({ kind: "unavailable", reason: "denied" });
  await settle();
  assert.equal(harness.state.session?.state.foregroundAction?.kind, "capture");
});
