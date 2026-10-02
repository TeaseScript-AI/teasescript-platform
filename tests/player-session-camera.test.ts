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
import { CaptureDelivery, SessionCamera, type PlayerDiagnostic } from "../player/session-camera.js";

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
    { code: "camera-denied", message: "The session camera is unavailable (denied)." },
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
  assert.deepEqual(await failing.camera.answer(), { kind: "unavailable", reason: "busy" });
  failing.frames.fail = false;
  assert.deepEqual(await failing.camera.answer(), { kind: "unavailable", reason: "busy" });
  assert.equal(failing.device.state("camera").status, "idle");
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

test("one capture is answered once and the same answer is delivered until it settles", async () => {
  const delivery = new CaptureDelivery();
  let captures = 0;
  const capture = async () => {
    captures++;
    return { kind: "captured" as const, reference: `photo-${captures}` };
  };
  const first = await delivery.answerFor(7, capture);
  // The runtime was not ready yet (`executionPending`): offering again reuses the same photo.
  assert.deepEqual(await delivery.answerFor(7, capture), first);
  assert.equal(captures, 1);
  delivery.settled(7);
  assert.deepEqual(await delivery.answerFor(8, capture), {
    kind: "captured",
    reference: "photo-2",
  });
});
