import assert from "node:assert/strict";
import test from "node:test";

import {
  CaptureDevice,
  type CaptureHost,
  type CaptureRequest,
  type CaptureTrack,
} from "../player/capture-device.js";
import { CapturedMediaStore } from "../player/captured-media.js";
import { RgbaImage } from "../player/rgba-image.js";
import {
  createPlayerRuntimeSession,
  type PlayerCaptureAnswer,
  type PlayerRuntimeSession,
} from "../player/runtime-adapter.js";
import { CaptureService, SessionCamera, type PlayerDiagnostic } from "../player/session-camera.js";

class FakeTrack implements CaptureTrack {
  readonly kind = "video";
  readonly label = "camera";
  readyState: "live" | "ended" = "live";
  readonly #ended: Array<() => void> = [];
  stop() {
    this.readyState = "ended";
  }
  addEventListener(_type: "ended", listener: () => void) {
    this.#ended.push(listener);
  }
  end() {
    this.readyState = "ended";
    for (const listener of this.#ended) listener();
  }
}

function harness(grant: (request: CaptureRequest) => Promise<readonly FakeTrack[]>) {
  const requests: CaptureRequest[] = [];
  const diagnostics: PlayerDiagnostic[] = [];
  const frames = { fail: false };
  const host: CaptureHost<FakeTrack> = {
    acquire: (request) => (requests.push(request), grant(request)),
    listDevices: async () => [],
    createRecorder: () => {
      throw new Error("not used");
    },
    grabFrame: async () => {
      if (frames.fail) throw Object.assign(new Error(), { name: "NotReadableError" });
      return new RgbaImage(1, 1, new Uint8ClampedArray([1, 2, 3, 255]));
    },
    encodeImage: async () => new Blob(["png"], { type: "image/png" }),
    decodeImage: async () => new RgbaImage(1, 1, new Uint8ClampedArray(4)),
    createAudioSampler: () => {
      throw new Error("not used");
    },
    now: () => 0,
    stateChanged: (kind, state) => {
      if (kind === "camera" && state.status === "ended") camera.revoked();
    },
  };
  const media = new CapturedMediaStore(
    null,
    { create: () => "blob:", revoke: () => {} },
    "package",
  );
  const device = new CaptureDevice(host, media);
  const camera: SessionCamera<FakeTrack> = new SessionCamera(device, (diagnostic) =>
    diagnostics.push(diagnostic),
  );
  return { camera, device, media, requests, diagnostics, frames };
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

test("a revoked or failing camera stays unavailable for the rest of the session", async () => {
  const track = new FakeTrack();
  const revoked = harness(async () => [track]);
  await revoked.camera.open(true);
  track.end();
  assert.deepEqual(await revoked.camera.answer(), { kind: "unavailable", reason: "revoked" });

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

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a capture is answered once and its photo continues the script", async () => {
  let answers = 0;
  const harness = serviceHarness(async () => {
    answers++;
    return { kind: "captured", reference: `photo-${answers}` };
  });
  harness.held.add("photo-1");
  harness.start("let photo = takePhoto()\nshowImage photo");
  harness.service.request();
  await settle();
  assert.equal(answers, 1);
  assert.equal(harness.state.session?.snapshot.status, "halted");
  assert.equal(harness.state.session?.snapshot.stageImage, "photo-1");
});

test("a session replaced while its photo is captured gets its own capture serviced", async () => {
  const answers: Array<(answer: PlayerCaptureAnswer) => void> = [];
  const harness = serviceHarness(() => new Promise((resolve) => answers.push(resolve)));
  harness.start("let photo = takePhoto()\nshowImage photo");
  harness.service.request();
  await settle();
  // Action IDs restart, so the successor's capture has the same ID as the replaced one.
  harness.start("let photo = takePhoto()\nshowImage photo");
  harness.held.add("old photo");
  answers[0]?.({ kind: "captured", reference: "old photo" });
  await settle();
  await settle();
  assert.equal(answers.length, 2);
  assert.equal(harness.state.session?.snapshot.foregroundAction?.kind, "capture");
  harness.held.add("new photo");
  answers[1]?.({ kind: "captured", reference: "new photo" });
  await settle();
  await settle();
  assert.equal(harness.state.session?.snapshot.stageImage, "new photo");
});

test("a captured reference the store does not hold never leaves the script waiting", async () => {
  const harness = serviceHarness(async () => ({ kind: "captured", reference: "unknown" }));
  harness.start("let photo = takePhoto()\nlet missing = photo == null");
  harness.service.request();
  await settle();
  assert.equal(harness.state.session?.snapshot.status, "halted");
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
  harness.start("while true {\n  takePhoto()\n}");
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
  harness.start("let photo = takePhoto()\nlet continued = true");
  harness.service.request();
  await settle();
  harness.service.stop();
  deliver({ kind: "unavailable", reason: "denied" });
  await settle();
  assert.equal(harness.state.session?.snapshot.foregroundAction?.kind, "capture");
});
