import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import {
  CaptureDevice,
  captureFailure,
  type AudioSampler,
  type CaptureHost,
  type CaptureRecorder,
  type CaptureRecorderSink,
  type CaptureRequest,
  type CaptureTrack,
} from "../player/capture-device.js";
import { untilReleased } from "../player/browser-capture.js";
import { RgbaImage } from "../player/rgba-image.js";
import { CapturedMediaNotStoredError, CapturedMediaStore } from "../player/captured-media.js";
import { FakeMediaRepository } from "./helpers/fake-media-repository.js";

// A deterministic stand-in for MediaStreamTrack: `end()` simulates the browser ending it, for example on revocation.
class FakeTrack implements CaptureTrack {
  readyState: "live" | "ended" = "live";
  stops = 0;
  readonly #ended: Array<() => void> = [];
  constructor(
    readonly kind: "video" | "audio",
    readonly label: string,
    private readonly log: string[],
  ) {}
  stop() {
    this.stops++;
    this.readyState = "ended";
    this.log.push(`stop ${this.label}`);
  }
  addEventListener(_type: "ended", listener: () => void) {
    this.#ended.push(listener);
  }
  end() {
    this.readyState = "ended";
    for (const listener of this.#ended) listener();
  }
}

class FakeRecorder implements CaptureRecorder {
  readonly mimeType: string;
  sink: CaptureRecorderSink | null = null;
  stops = 0;
  constructor(readonly tracks: readonly FakeTrack[]) {
    this.mimeType = tracks.some((track) => track.kind === "video") ? "video/webm" : "audio/webm";
  }
  start(sink: CaptureRecorderSink) {
    this.sink = sink;
    sink.data(new Blob(["first"]));
  }
  // Browsers deliver the last data and the stop event asynchronously.
  stop() {
    this.stops++;
    queueMicrotask(() => {
      this.sink?.data(new Blob(["last"]));
      this.sink?.stopped();
    });
  }
}

interface PendingAcquire {
  readonly request: CaptureRequest;
  resolve(tracks: readonly FakeTrack[]): void;
  reject(error: unknown): void;
}

function image(width = 2, height = 1): RgbaImage {
  return new RgbaImage(width, height, new Uint8ClampedArray([10, 20, 30, 255, 11, 20, 30, 255]));
}

/** Lets pending promise continuations run, for example a queued acquisition. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

// A lossless stand-in for PNG (dimensions, then channels), so reading a photo back proves which pixels were stored.
const fakeCodec = {
  encode: (pixels: RgbaImage) =>
    new Blob([new Uint32Array([pixels.width, pixels.height]), new Uint8Array(pixels.data)], {
      type: "image/png",
    }),
  async decode(data: Blob) {
    const bytes = await data.arrayBuffer();
    const [width = 0, height = 0] = new Uint32Array(bytes, 0, 2);
    return new RgbaImage(width, height, new Uint8ClampedArray(bytes, 8));
  },
};

function harness() {
  const log: string[] = [];
  const states: string[] = [];
  const pending: PendingAcquire[] = [];
  const recorders: FakeRecorder[] = [];
  const samplers: Array<{ closed: number }> = [];
  const urls: string[] = [];
  const clock = { now: 0 };
  const frames: Array<{ resolve(image: RgbaImage): void; signal: AbortSignal }> = [];
  const encodes: Array<() => void> = [];
  const options = { holdEncoding: false };
  let tracks = 0;
  const host: CaptureHost<FakeTrack> = {
    acquire: (request) =>
      new Promise((resolve, reject) => {
        log.push(`acquire ${Object.keys(request).join("+")}`);
        pending.push({ request, resolve, reject });
      }),
    listDevices: async () => [{ kind: "camera", deviceId: "front", label: "" }],
    createRecorder: (recorded) => {
      const recorder = new FakeRecorder(recorded);
      recorders.push(recorder);
      return recorder;
    },
    // Like the browser host, a pending grab rejects once its track is released.
    grabFrame: (_track, signal) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        frames.push({ resolve, signal });
      }),
    encodeImage: (pixels) =>
      options.holdEncoding
        ? new Promise((resolve) => encodes.push(() => resolve(fakeCodec.encode(pixels))))
        : Promise.resolve(fakeCodec.encode(pixels)),
    decodeImage: (data) => fakeCodec.decode(data),
    createAudioSampler: () => {
      const state = { closed: 0 };
      samplers.push(state);
      const sampler: AudioSampler = {
        running: true,
        sampleRate: 48_000,
        windowSize: 4,
        readTimeDomain: (target) => target.fill(0.5),
        readFrequency: (target) => target.fill(-30),
        close: () => state.closed++,
      };
      return sampler;
    },
    now: () => clock.now,
    stateChanged: (kind, state) => states.push(`${kind}:${state.status}`),
  };
  const repository = new FakeMediaRepository();
  const media = new CapturedMediaStore(
    repository,
    {
      create: (data) => {
        const url = `blob:${urls.length}:${data.size}`;
        urls.push(url);
        return url;
      },
      revoke: (url) => log.push(`revoke ${url}`),
    },
    "package",
  );
  const device = new CaptureDevice(host, media);
  const track = (kind: "video" | "audio") => new FakeTrack(kind, `${kind}${++tracks}`, log);
  /** Starts an acquisition and lets the browser grant it with fresh tracks of the requested kinds. */
  async function grant(request: CaptureRequest) {
    const outcome = device.acquire(request);
    const granted: FakeTrack[] = [];
    if (request.camera !== undefined) granted.push(track("video"));
    if (request.microphone !== undefined) granted.push(track("audio"));
    pending.pop()?.resolve(granted);
    assert.deepEqual(await outcome, { kind: "active" });
    return granted;
  }
  return {
    device,
    media,
    repository,
    log,
    states,
    pending,
    recorders,
    samplers,
    frames,
    encodes,
    options,
    clock,
    track,
    grant,
  };
}

test("one browser request opens camera and microphone together", async () => {
  const { device, log, states, grant } = harness();
  await grant({ camera: {}, microphone: {} });
  assert.deepEqual(log, ["acquire camera+microphone"]);
  assert.deepEqual(states, [
    "camera:acquiring",
    "microphone:acquiring",
    "camera:active",
    "microphone:active",
  ]);
  assert.equal(device.state("camera").status, "active");
  assert.equal(device.track("microphone")?.kind, "audio");
});

test("switching cameras stops the open stream before requesting the next one", async () => {
  const { device, log, grant } = harness();
  const [first] = await grant({ camera: { deviceId: "front" }, microphone: {} });
  const [second] = await grant({ camera: { deviceId: "back" } });
  assert.deepEqual(log, ["acquire camera+microphone", `stop ${first?.label}`, "acquire camera"]);
  assert.equal(device.track("camera"), second);
  // A camera switch leaves the microphone open.
  assert.equal(device.state("microphone").status, "active");
});

test("a replaced request finishes and releases its stream before the browser is asked again", async () => {
  const { device, pending, track, log } = harness();
  const replaced = device.acquire({ camera: { deviceId: "front" } });
  const current = device.acquire({ camera: { deviceId: "back" } });
  // A camera that allows one open stream must never see the second request while the first is open.
  assert.deepEqual(log, ["acquire camera"]);
  const late = track("video");
  pending[0]?.resolve([late]);
  assert.deepEqual(await replaced, { kind: "superseded" });
  assert.equal(late.stops, 1);
  await flush();
  assert.deepEqual(log, ["acquire camera", `stop ${late.label}`, "acquire camera"]);
  assert.deepEqual(pending[1]?.request, { camera: { deviceId: "back" } });
  const winner = track("video");
  pending[1]?.resolve([winner]);
  assert.deepEqual(await current, { kind: "active" });
  assert.equal(device.track("camera"), winner);
  assert.equal(winner.stops, 0);
});

test("a stream that arrives after its kind was stopped is released", async () => {
  const { device, pending, track, states } = harness();
  const abandoned = device.acquire({ microphone: {} });
  device.stop("microphone");
  const arriving = track("audio");
  pending[0]?.resolve([arriving]);
  assert.deepEqual(await abandoned, { kind: "superseded" });
  assert.equal(arriving.stops, 1);
  assert.equal(device.state("microphone").status, "idle");
  assert.equal(states.at(-1), "microphone:idle");
});

test("a queued request only asks for the kinds still wanted", async () => {
  const { device, pending, track, log } = harness();
  const first = device.acquire({ camera: {} });
  const both = device.acquire({ camera: {}, microphone: {} });
  device.stop("camera");
  pending[0]?.resolve([track("video")]);
  await first;
  await flush();
  assert.deepEqual(log.at(-1), "acquire microphone");
  pending[1]?.resolve([track("audio")]);
  assert.deepEqual(await both, { kind: "superseded" });
  assert.equal(device.state("microphone").status, "active");
  assert.equal(device.state("camera").status, "idle");
});

test("browser exceptions become bounded failures without browser messages", async () => {
  const names: Array<[string, string]> = [
    ["NotAllowedError", "denied"],
    ["SecurityError", "denied"],
    ["NotFoundError", "not-found"],
    ["NotReadableError", "busy"],
    ["AbortError", "busy"],
    ["OverconstrainedError", "overconstrained"],
    ["NotSupportedError", "unsupported"],
    ["TypeError", "unsupported"],
    ["SomethingNew", "failed"],
  ];
  for (const [name, kind] of names) {
    const error = Object.assign(new Error("Camera 0000:00:14.0 is busy"), { name });
    const failure = captureFailure(error);
    assert.equal(failure.kind, kind, name);
    assert.doesNotMatch(failure.message, /0000/u);
  }
  assert.equal(captureFailure("not an error").kind, "failed");

  const { device, pending } = harness();
  const outcome = device.acquire({ camera: {} });
  pending[0]?.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
  assert.deepEqual(await outcome, {
    kind: "failed",
    failure: captureFailure({ name: "NotAllowedError" }),
  });
  assert.deepEqual(device.state("camera"), {
    status: "failed",
    failure: captureFailure({ name: "NotAllowedError" }),
  });
});

test("tracks nobody requested are stopped and a missing requested track fails", async () => {
  const { device, pending, track } = harness();
  const outcome = device.acquire({ camera: {} });
  const unrequested = track("audio");
  pending[0]?.resolve([unrequested]);
  assert.equal((await outcome).kind, "failed");
  assert.deepEqual(device.state("camera"), {
    status: "failed",
    failure: captureFailure({ name: "NotFoundError" }),
  });
  assert.equal(unrequested.stops, 1);
  assert.equal(device.track("microphone"), null);
});

test("a frame is copied from the active camera while recording continues", async () => {
  const { device, frames, recorders, grant } = harness();
  assert.deepEqual(await device.captureFrame(), {
    kind: "failed",
    failure: { kind: "inactive", message: "The required device is not active." },
  });
  const [camera] = await grant({ camera: {} });
  const started = device.startRecording(["camera"]);
  assert.equal(started.kind, "recording");
  const frame = device.captureFrame();
  frames[0]?.resolve(image());
  const outcome = await frame;
  assert.equal(outcome.kind, "frame");
  if (outcome.kind === "frame") {
    const left = outcome.image.getPixel(0, 0);
    const right = outcome.image.getPixel(1, 0);
    assert.deepEqual(left, { r: 10, g: 20, b: 30, a: 255 });
    assert.equal(right.r - left.r, 1);
  }
  assert.equal(recorders[0]?.stops, 0);
  assert.equal(camera?.stops, 0);
  assert.equal(device.recording?.sources[0], "camera");
});

test("a frame still pending when the camera stops settles as inactive", async () => {
  const { device, frames, grant } = harness();
  await grant({ camera: {} });
  const frame = device.captureFrame();
  device.stop("camera");
  assert.equal(frames[0]?.signal.aborted, true);
  assert.deepEqual(await frame, {
    kind: "failed",
    failure: { kind: "inactive", message: "The required device is not active." },
  });
});

test("a photo is stored as session media and its pixels can be read back", async () => {
  const { device, media, frames, grant } = harness();
  await grant({ camera: {} });
  const photo = device.capturePhoto();
  frames[0]?.resolve(image());
  const outcome = await photo;
  assert.equal(outcome.kind, "photo");
  if (outcome.kind !== "photo") return;
  // Only this plain description may reach runtime state; it survives serialization unchanged.
  assert.deepEqual(JSON.parse(JSON.stringify(outcome.media)), outcome.media);
  const { reference, size, ...description } = outcome.media;
  assert.deepEqual(description, { kind: "image", mimeType: "image/png", width: 2, height: 1 });
  assert.equal((await media.read(reference))?.data.size, size);
  const read = await device.readImage(reference);
  assert.deepEqual(read.kind === "frame" && [...read.image.data], [...image().data]);
  assert.equal((await device.readImage(`${reference}-missing`)).kind, "failed");
});

test("a photo still encoding when the session resets is not stored", async () => {
  const { device, media, frames, encodes, options, grant } = harness();
  options.holdEncoding = true;
  await grant({ camera: {} });
  const photo = device.capturePhoto();
  frames[0]?.resolve(image());
  await flush();
  assert.equal(encodes.length, 1);
  device.reset();
  encodes[0]?.();
  assert.equal((await photo).kind, "failed");
  assert.equal(media.size, 0);
});

test("a recording stores what was recorded and reports its duration", async () => {
  const { device, media, clock, grant } = harness();
  await grant({ camera: {}, microphone: {} });
  const started = device.startRecording(["camera", "microphone"]);
  assert.equal(started.kind, "recording");
  if (started.kind !== "recording") return;
  assert.deepEqual(device.startRecording(["microphone"]), {
    kind: "failed",
    failure: { kind: "busy", message: "The device is in use or could not be started." },
  });
  clock.now = 1500;
  started.recording.stop();
  const outcome = await started.recording.finished;
  assert.equal(outcome.kind, "recorded");
  if (outcome.kind !== "recorded") return;
  assert.equal(outcome.durationMs, 1500);
  assert.equal(outcome.interrupted, false);
  assert.deepEqual(
    { kind: outcome.media.kind, mimeType: outcome.media.mimeType, size: outcome.media.size },
    { kind: "video", mimeType: "video/webm", size: "firstlast".length },
  );
  assert.equal((await media.read(outcome.media.reference))?.data.size, "firstlast".length);
  assert.equal(device.recording, null);
  // Both streams stay open after a recording ends.
  assert.equal(device.state("camera").status, "active");
});

test("a stopped recording still finishing blocks a new one and is cancelled by reset", async () => {
  const { device, media, grant } = harness();
  await grant({ microphone: {} });
  const started = device.startRecording(["microphone"]);
  if (started.kind !== "recording") return assert.fail(started.kind);
  started.recording.stop();
  assert.equal(device.startRecording(["microphone"]).kind, "failed");
  // The session ends before the browser delivered the last data.
  device.reset();
  assert.deepEqual(await started.recording.finished, { kind: "cancelled" });
  await Promise.resolve();
  assert.equal(media.size, 0);
});

test("a cancelled recording stores nothing", async () => {
  const { device, media, grant } = harness();
  await grant({ microphone: {} });
  assert.equal(device.startRecording(["camera"]).kind, "failed");
  const started = device.startRecording(["microphone"]);
  if (started.kind !== "recording") return assert.fail(started.kind);
  started.recording.cancel();
  assert.deepEqual(await started.recording.finished, { kind: "cancelled" });
  await Promise.resolve();
  assert.equal(media.size, 0);
});

test("a recorder failure settles the recording as failed", async () => {
  const { device, recorders, grant } = harness();
  await grant({ microphone: {} });
  const started = device.startRecording(["microphone"]);
  if (started.kind !== "recording") return assert.fail(started.kind);
  recorders[0]?.sink?.failed(Object.assign(new Error("x"), { name: "NotReadableError" }));
  assert.equal((await started.recording.finished).kind, "failed");
  assert.equal(device.recording, null);
});

test("a revoked microphone ends its recording and closes its samplers", async () => {
  const { device, media, samplers, states, grant } = harness();
  const [camera, microphone] = await grant({ camera: {}, microphone: {} });
  const sampler = device.openAudioSampler();
  if (sampler.kind !== "sampler") return assert.fail(sampler.kind);
  const samples = new Float32Array(sampler.sampler.windowSize);
  sampler.sampler.readTimeDomain(samples);
  assert.deepEqual([...samples], [0.5, 0.5, 0.5, 0.5]);
  assert.equal(sampler.sampler.running, true);
  const started = device.startRecording(["microphone"]);
  if (started.kind !== "recording") return assert.fail(started.kind);

  microphone?.end();
  const outcome = await started.recording.finished;
  assert.equal(outcome.kind === "recorded" && outcome.interrupted, true);
  assert.equal(outcome.kind === "recorded" && outcome.media.kind, "audio");
  assert.equal(media.size, 1);
  assert.equal(samplers[0]?.closed, 1);
  assert.equal(states.at(-1), "microphone:ended");
  assert.equal(device.openAudioSampler().kind, "failed");
  // A closed sampler no longer reads the released stream.
  assert.equal(sampler.sampler.running, false);
  samples.fill(0);
  sampler.sampler.readTimeDomain(samples);
  assert.deepEqual([...samples], [0, 0, 0, 0]);
  assert.equal(camera?.stops, 0);
  assert.equal(device.state("camera").status, "active");
});

test("reset cancels recording, closes samplers and stops every stream", async () => {
  const { device, media, pending, samplers, grant, track } = harness();
  const late = device.acquire({ camera: {} });
  const [microphone] = await grant({ microphone: {} });
  device.openAudioSampler();
  const started = device.startRecording(["microphone"]);
  if (started.kind !== "recording") return assert.fail(started.kind);
  device.reset();
  assert.deepEqual(await started.recording.finished, { kind: "cancelled" });
  assert.equal(microphone?.stops, 1);
  assert.equal(samplers[0]?.closed, 1);
  assert.equal(device.state("camera").status, "idle");
  assert.equal(device.state("microphone").status, "idle");
  const arriving = track("video");
  pending[0]?.resolve([arriving]);
  assert.deepEqual(await late, { kind: "superseded" });
  assert.equal(arriving.stops, 1);
  await Promise.resolve();
  assert.equal(media.size, 0);
});

test("pixel access validates dimensions and coordinates", () => {
  assert.throws(() => new RgbaImage(2, 2, new Uint8ClampedArray(15)), RangeError);
  assert.throws(() => new RgbaImage(0, 1, new Uint8ClampedArray(0)), RangeError);
  const pixels = image();
  for (const [x, y] of [
    [2, 0],
    [0, 1],
    [-1, 0],
    [0.5, 0],
  ] as const)
    assert.throws(() => pixels.getPixel(x, y), RangeError, `${x},${y}`);
});

test("a capture is session media and needs no durable storage", async () => {
  const urls = { create: () => "blob:", revoke: () => {} };
  const media = new CapturedMediaStore(null, urls, "package");
  const entry = media.add("image", new Blob(["x"], { type: "image/png" }));
  assert.equal(media.holds(entry.reference, "image"), true);
  assert.equal(media.resolve(entry.reference).state, "ready");
  await assert.rejects(media.promote([entry.reference]), CapturedMediaNotStoredError);
  // The capture stays usable for the session.
  assert.equal(media.holds(entry.reference, "image"), true);
});

test("a promoted reference resolves to the same media in a later run and new captures never alias it", async () => {
  const repository = new FakeMediaRepository();
  const urls = { create: (data: Blob) => `blob:${data.size}`, revoke: () => {} };
  const earlier = new CapturedMediaStore(repository, urls, "package");
  // For example saved with `save`, then loaded after the earlier run ended.
  const kept = earlier.add("image", new Blob(["earlier"], { type: "image/png" })).reference;
  assert.equal(repository.size, 0);
  await earlier.promote([kept, "captured-media:forged:1", "images/coast.svg"]);
  assert.equal(repository.size, 1);
  // Promotion is idempotent and never rewrites stored media.
  await earlier.promote([kept]);
  earlier.close();
  let changes = 0;
  const later = new CapturedMediaStore(repository, urls, "package", () => changes++);
  assert.deepEqual(later.resolve(kept), { state: "loading" });
  await flush();
  assert.equal(changes, 1);
  assert.deepEqual(later.resolve(kept), { state: "ready", url: "blob:7" });
  assert.equal(await (await later.read(kept))?.data.text(), "earlier");
  const captured = later.add("image", new Blob(["later"], { type: "image/png" }));
  assert.notEqual(captured.reference, kept);
  // Another package never resolves it.
  const other = new CapturedMediaStore(repository, urls, "other package");
  other.resolve(kept);
  await flush();
  assert.deepEqual(other.resolve(kept), { state: "missing" });
});

test("a promotion that an earlier attempt already committed counts as stored", async () => {
  const repository = new FakeMediaRepository();
  const media = new CapturedMediaStore(
    repository,
    { create: () => "blob:", revoke: () => {} },
    "package",
  );
  const entry = media.add("image", new Blob(["x"], { type: "image/png" }));
  const record = await media.read(entry.reference);
  assert.ok(record !== null);
  await repository.add(record);
  await media.promote([entry.reference]);
  repository.failWrites = true;
  await media.promote([entry.reference]);
  assert.equal(repository.size, 1);
});

test("invalid stored records never resolve", async () => {
  const repository = new FakeMediaRepository();
  const urls = { create: () => "blob:", revoke: () => {} };
  const reference = (n: number) => `captured-media:00000000-0000-4000-8000-000000000000:${n}`;
  const png = new Blob(["x"], { type: "image/png" });
  const valid = { namespace: "package", kind: "image", mimeType: "image/png", size: 1, data: png };
  const invalid: Array<Record<string, unknown>> = [
    { ...valid, mimeType: "text/html" },
    { ...valid, kind: "document" },
    { ...valid, size: Number.NaN },
    { ...valid, width: -1 },
    { ...valid, durationMs: Number.POSITIVE_INFINITY },
    { ...valid, data: "x" },
    { ...valid, namespace: "other package" },
  ];
  invalid.forEach((record, index) =>
    repository.records.set(`package ${reference(index + 1)}`, {
      ...record,
      reference: reference(index + 1),
    }),
  );
  repository.records.set(`package captured-media:`, { ...valid, reference: "captured-media:" });
  const store = new CapturedMediaStore(repository, urls, "package");
  for (let index = 1; index <= invalid.length; index++) store.resolve(reference(index));
  await flush();
  for (let index = 1; index <= invalid.length; index++)
    assert.deepEqual(store.resolve(reference(index)), { state: "missing" }, `record ${index}`);
  assert.deepEqual(store.resolve("captured-media:"), { state: "missing" });
  // A package asset path is never treated as captured media.
  assert.deepEqual(store.resolve("images/coast.svg"), { state: "missing" });
  assert.equal(store.holds("images/coast.svg", "image"), false);
});

test("a sweep deletes only stored media no saved value references", async () => {
  const repository = new FakeMediaRepository();
  const urls = { create: () => "blob:", revoke: () => {} };
  const earlier = new CapturedMediaStore(repository, urls, "package");
  const saved = earlier.add("image", new Blob(["a"], { type: "image/png" })).reference;
  const dropped = earlier.add("image", new Blob(["b"], { type: "image/png" })).reference;
  await earlier.promote([saved, dropped]);
  const foreign = new CapturedMediaStore(repository, urls, "other package");
  await foreign.promote([foreign.add("image", new Blob(["c"], { type: "image/png" })).reference]);
  earlier.close();
  const later = new CapturedMediaStore(repository, urls, "package");
  assert.equal(await later.sweep(new Set([saved])), 1);
  assert.deepEqual(await repository.listReferences("package"), [saved]);
  // Other packages are untouched.
  assert.equal((await repository.listReferences("other package")).length, 1);
});

test("waiting on a long-open camera leaves no abort listener behind", async () => {
  const released = new AbortController();
  for (let grab = 0; grab < 8; grab++)
    assert.equal(await untilReleased(Promise.resolve(grab), released.signal), grab);
  await assert.rejects(
    untilReleased(Promise.reject(new Error("no frame")), released.signal),
    /no frame/u,
  );
  assert.equal(getEventListeners(released.signal, "abort").length, 0);
  const pending = untilReleased(new Promise(() => {}), released.signal);
  released.abort(new DOMException("released", "AbortError"));
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(getEventListeners(released.signal, "abort").length, 0);
});
