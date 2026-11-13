import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  CaptureDevice,
  type CaptureHost,
  type CaptureTrack,
} from "../../player/media/capture-device.js";
import { CapturedMediaStore } from "../../player/media/captured-media.js";
import { createPlayerRuntimeSession } from "../../player/runtime/compile-project.js";
import { loadAge, loadTlock, type LockServices } from "../../player/encryption/content-lock.js";
import { LockService, type LockDialog } from "../../player/encryption/lock-service.js";
import { RgbaImage } from "../../player/media/rgba-image.js";
import {
  observePlayerRuntimeTime,
  playerRuntimeSnapshot,
  resumePlayerRuntimeRandomDraw,
  type PlayerCaptureAnswer,
} from "../../player/runtime/runtime-adapter.js";
import type { PlayerSession } from "../../player/runtime/runtime-view.js";
import { CaptureService, SessionCamera } from "../../player/media/session-camera.js";
import { FileStoreService, type FileStoreMedia } from "../../player/media/stored-files.js";
import { hatch, inProcessBridge, introduced } from "../helpers/in-process-bridge.js";
import { serviceSection } from "../helpers/service-section.js";

// The media a service makes for an answer is the service's until the runtime takes it (#1882): an answer that will
// never be handed off releases its new media, and one the runtime may have taken keeps it. The oracle compares the
// store's records with the media the session's canonical state references. Replies come late through the in-process
// host, so a request is in flight while the service is reset.

const urls = { create: () => "blob:", revoke: () => {} };
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PNG = Buffer.from(PNG_BYTES).toString("base64");
const NOW_MS = Date.UTC(2026, 0, 1);
const png = () => new Blob([PNG_BYTES], { type: "image/png" });

/** A gate that holds until opened. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

async function until(done: () => boolean, message: string) {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const pause = (milliseconds = 60) => new Promise((resolve) => setTimeout(resolve, milliseconds));

type Producer = "capture" | "file" | "encrypt" | "decrypt";
/**
 * When the service is reset: never, while the answer is made, at the observation before its send, or as it is sent.
 * `drawAtObservation` resets nothing: time passes at the answer's observation, a repeating timer's draw pauses the
 * session there, and the engine answers `randomDrawPending` without taking the answer, which the service settles.
 */
type Moment =
  "none" | "whileMade" | "beforeSend" | "afterSend" | "stopBeforeSend" | "drawAtObservation";

const ANSWER_OPS = {
  capture: "answerCapture",
  file: "answerFileStore",
  encrypt: "answerLock",
  decrypt: "answerLock",
} as const;

/**
 * One session of `producer`'s script, serviced by its real service over the in-process host with late replies and a
 * real media store, reset at `moment` of its target answer (the decrypt step's is the second lock answer).
 */
async function serviced(producer: Producer, moment: Moment) {
  const bridge = await inProcessBridge(30);
  const store = new CapturedMediaStore(null, urls, "unpublished");
  const files: string[] = [];
  if (producer === "encrypt" || producer === "decrypt")
    files.push(store.add("image", png()).reference);
  const drawing = moment === "drawAtObservation";
  const source =
    (drawing ? "let tick = timer(duration: (1..=2) s, async: true, repeat: true)\n" : "") +
    {
      capture: "let made = takePhoto()\nexit",
      file: `let made = fileFromBase64("${PNG}", default: "")\nexit`,
      encrypt: `let photo = "${files[0]}"\nlet made = encryptFile(photo, password: "p", publicKey: false, timeLock: false)\nexit`,
      decrypt: `let photo = "${files[0]}"\nlet locked = encryptFile(photo, password: "p", publicKey: false, timeLock: false)\nlet made = decryptFile(locked, password: "p", default: null)\nexit`,
    }[producer];
  const target = producer === "decrypt" ? 2 : 1;
  let session: PlayerSession | null = introduced(
    bridge,
    createPlayerRuntimeSession(source, {
      wallClockMs: NOW_MS,
      storedFiles: files,
      // Debug's random control pauses at the timer's next duration.
      ...(drawing ? { randomControl: { filter: { kinds: ["timerRepeat" as const] } } } : {}),
    }),
  );
  let answers = 0;
  let drawn = false;
  let resumed = false;
  let observes = 0;
  let interrupted = false;
  const services: { request(): void; reset(): void; stop(): void }[] = [];
  const interrupt = () => {
    if (interrupted) return;
    interrupted = true;
    if (moment === "stopBeforeSend") services.forEach((service) => service.stop());
    else {
      services.forEach((service) => service.reset());
      setImmediate(() => services.forEach((service) => service.request()));
    }
  };
  let adds = 0;
  // While the target answer is made: the photo waits for its encoding, a lock for the file it reads.
  const making = gate();
  let reads = 0;
  const media: FileStoreMedia = {
    add: (kind, data, details) => (adds++, store.add(kind, data, details)),
    holds: (reference, kind) => store.holds(reference, kind),
    discard: (reference) => store.discard(reference),
    read: async (reference) => {
      reads++;
      if (moment === "whileMade" && reads === target) {
        // Once the service holds this answer: a reset in the same tick would come before it.
        queueMicrotask(interrupt);
        await making.opened;
      }
      return store.read(reference);
    },
  };
  const host = {
    session: () => session,
    generation: () => 1,
    section: serviceSection(
      bridge,
      () => session,
      (next) => {
        session = next;
        services.forEach((service) => service.request());
      },
      (op) => {
        if (op === ANSWER_OPS[producer]) answers++;
        if (op === "observeTime" && answers === target - 1) observes++;
        const atObservation = op === "observeTime" && answers === target - 1 && observes === 1;
        if ((moment === "beforeSend" || moment === "stopBeforeSend") && atObservation) interrupt();
        if (moment === "afterSend" && op === ANSWER_OPS[producer] && answers === target)
          interrupt();
        // The draw is decided once the answer it held back was sent: the next answer is taken.
        if (drawing && drawn && !resumed && op === ANSWER_OPS[producer]) {
          resumed = true;
          setImmediate(() => {
            assert.ok(session!.state.randomDraw !== null, "no draw paused the session");
            // The timer's next repeats may be due by then too: each is decided as it comes.
            for (;;) {
              const draw = session!.state.randomDraw;
              if (draw === null) break;
              session = hatch(session!, (held) =>
                resumePlayerRuntimeRandomDraw(held, { drawId: draw.drawId, outcome: "natural" }),
              ).session;
            }
            services.forEach((service) => service.request());
          });
        }
      },
      () => {
        // Time passes up to the target answer's observation, past the timer's first expiry.
        if (!drawing || drawn || answers !== target - 1) return 0;
        drawn = true;
        return 3_000;
      },
    ),
    diagnostic: (diagnostic: { message: string }) => assert.fail(diagnostic.message),
    later: (task: () => void) => setImmediate(task),
  };
  let photos = 0;
  if (producer === "capture")
    services.push(
      new CaptureService(
        async () => {
          photos++;
          if (moment === "whileMade" && photos === 1) {
            queueMicrotask(interrupt);
            await making.opened;
          }
          return { kind: "captured", reference: store.add("image", png()).reference };
        },
        { ...host, capturedMedia: store },
      ),
    );
  else if (producer === "file") services.push(new FileStoreService({ ...host, media }));
  else services.push(lockService(host, media));
  services.forEach((service) => service.request());
  try {
    if (moment === "whileMade") {
      await until(() => interrupted, "the answer was not made");
      await pause();
      making.open();
    }
    if (moment === "stopBeforeSend") {
      await until(() => interrupted, "the service was not stopped");
      await pause(150);
    } else
      await until(
        () => session!.state.status === "halted" || session!.state.status === "failed",
        `the session did not end (${session!.state.status})`,
      );
  } finally {
    await pause();
    services.forEach((service) => service.stop());
  }
  const snapshot = hatch(session!, playerRuntimeSnapshot);
  const values = Object.fromEntries(
    snapshot.frames[0]!.bindings.map((binding) => [binding.name, binding.value]),
  );
  const used = new Set(
    [...files, values["locked"], values["made"]].filter(
      (value): value is string => typeof value === "string",
    ),
  );
  // How many answers were made: photos taken, or files a lock step read.
  const produced = producer === "capture" ? photos : producer === "file" ? adds : reads;
  return { store, used, made: values["made"], answers, produced, status: snapshot.status };
}

function lockService(
  host: {
    session(): PlayerSession | null;
    generation(): number;
    section: ReturnType<typeof serviceSection>;
    diagnostic(diagnostic: { message: string }): void;
    later(task: () => void): void;
  },
  media: FileStoreMedia,
  dialog: (dialog: LockDialog | null) => void = () => {},
): LockService {
  const crypto: LockServices = {
    tlock: loadTlock,
    age: loadAge,
    fetch: async () => new Response("", { status: 500 }),
    nowMs: () => NOW_MS,
  };
  return new LockService({
    ...host,
    media,
    dialog,
    after: () => () => {},
    subtle: globalThis.crypto.subtle,
    crypto,
  });
}

/** Whether `store` holds exactly the media in `used`. */
async function holdsExactly(store: CapturedMediaStore, used: ReadonlySet<string>) {
  assert.equal(store.size, used.size, `held ${store.size}, the state uses ${used.size}`);
  for (const reference of used) assert.ok(store.knows(reference), reference);
}

for (const producer of ["capture", "file", "encrypt", "decrypt"] as const)
  for (const moment of [
    "none",
    "whileMade",
    "beforeSend",
    "afterSend",
    "drawAtObservation",
  ] as const) {
    // A file store's answer is made at once.
    if (producer === "file" && moment === "whileMade") continue;
    const when = moment === "drawAtObservation" ? "a draw at its observation" : `reset ${moment}`;
    test(`${producer}, ${when}: the store holds exactly the media the session's state uses`, async () => {
      const result = await serviced(producer, moment);
      assert.equal(result.status, "halted");
      // A retired, or not taken, answer is made again: one more photo or file, or one more read of the lock's file.
      if (moment === "whileMade" || moment === "drawAtObservation")
        assert.equal(
          result.produced,
          producer === "decrypt" ? 3 : 2,
          "the retired answer was taken",
        );
      assert.equal(typeof result.made, "string", "the state's result is a file");
      await holdsExactly(result.store, result.used);
    });
  }

test("a capture stopped before its answer is sent leaves no photo", async () => {
  const result = await serviced("capture", "stopBeforeSend");
  assert.equal(result.answers, 0);
  assert.equal(result.store.size, 0);
});

/** A capture service whose first answer is refused for its basis, as when another op replaced the session meanwhile. */
async function refusedOnce(producer: "capture" | "file") {
  const bridge = await inProcessBridge();
  const store = new CapturedMediaStore(null, urls, "unpublished");
  const source =
    producer === "capture"
      ? "let made = takePhoto()\nexit"
      : `let made = fileFromBase64("${PNG}", default: "")\nexit`;
  const state: { session: PlayerSession | null; generation: number } = {
    session: introduced(bridge, createPlayerRuntimeSession(source, { wallClockMs: NOW_MS })),
    generation: 1,
  };
  let sends = 0;
  let made = 0;
  const tasks: (() => void)[] = [];
  const host = {
    session: () => state.session,
    generation: () => state.generation,
    section: serviceSection(
      bridge,
      () => state.session,
      (next) => (state.session = next),
      (op) => {
        if (op !== ANSWER_OPS[producer]) return;
        sends++;
        // A hatch call publishes a newer revision first, so this answer's basis is out of date.
        if (sends === 1)
          hatch(state.session!, (held) =>
            observePlayerRuntimeTime(held, held.state.observedSessionTimeMs + 1, []),
          );
      },
    ),
    diagnostic: (diagnostic: { message: string }) => assert.fail(diagnostic.message),
    later: (task: () => void) => void tasks.push(task),
  };
  const service =
    producer === "capture"
      ? new CaptureService(
          async () => (
            made++,
            { kind: "captured", reference: store.add("image", png()).reference }
          ),
          { ...host, capturedMedia: store },
        )
      : new FileStoreService({ ...host, media: store });
  service.request();
  const run = async () => {
    for (let round = 0; round < 50 && tasks.length > 0; round++) {
      tasks.shift()!();
      await pause(10);
    }
  };
  // The first pass: refused for its basis, the answer stays for a retry.
  tasks.shift()!();
  await until(() => tasks.length > 0, "the refusal was not settled");
  assert.equal(sends, 1);
  assert.equal(store.size, 1);
  return { bridge, store, state, service, run, sends: () => sends, made: () => made };
}

for (const producer of ["capture", "file"] as const)
  test(`${producer}: a retry the next generation retires releases its media with no other answer made`, async () => {
    const control = await refusedOnce(producer);
    await control.run();
    assert.equal(control.state.session?.state.status, "halted", "the retry was taken");
    assert.equal(control.sends(), 2);
    assert.equal(control.store.size, 1, "one answer's media, sent twice");
    control.service.stop();

    const retired = await refusedOnce(producer);
    // As Back publishes an inspected state: a new generation, with no session to service.
    retired.state.generation++;
    retired.state.session = null;
    retired.service.request();
    await retired.run();
    assert.equal(retired.sends(), 1);
    assert.equal(retired.store.size, 0, "the retired answer's media stays held");
    retired.service.stop();
  });

test("a lock answer cached for a retry is released when the next generation's step asks first", async (context) => {
  const bridge = await inProcessBridge();
  const store = new CapturedMediaStore(null, urls, "unpublished");
  const photo = store.add("image", png()).reference;
  const encrypting = `let photo = "${photo}"\nlet made = encryptFile(photo, password: "p", publicKey: false, timeLock: false)\nexit`;
  const asking = `let photo = "${photo}"\nlet made = encryptFile(photo, password: true, publicKey: false, timeLock: false)\nexit`;
  const state: { session: PlayerSession | null; generation: number } = {
    session: introduced(
      bridge,
      createPlayerRuntimeSession(encrypting, { wallClockMs: NOW_MS, storedFiles: [photo] }),
    ),
    generation: 1,
  };
  let sends = 0;
  const dialogs: (LockDialog | null)[] = [];
  const tasks: (() => void)[] = [];
  const service = lockService(
    {
      session: () => state.session,
      generation: () => state.generation,
      section: serviceSection(
        bridge,
        () => state.session,
        (next) => (state.session = next),
        (op) => {
          if (op !== "answerLock") return;
          sends++;
          if (sends === 1)
            hatch(state.session!, (held) =>
              observePlayerRuntimeTime(held, held.state.observedSessionTimeMs + 1, []),
            );
        },
      ),
      diagnostic: (diagnostic) => assert.fail(diagnostic.message),
      later: (task) => void tasks.push(task),
    },
    store,
    (dialog) => dialogs.push(dialog),
  );
  context.after(() => service.stop());
  service.request();
  tasks.shift()!();
  // Refused for its basis, the locked file waits for a retry.
  await until(() => tasks.length > 0, "the refusal was not settled");
  assert.equal(sends, 1);
  assert.equal(store.size, 2);
  // The next generation's lock step asks for its openers first; the cached locked file is never sent.
  state.generation++;
  state.session = introduced(
    bridge,
    createPlayerRuntimeSession(asking, { wallClockMs: NOW_MS, storedFiles: [photo] }),
  );
  service.request();
  for (let round = 0; round < 20 && !dialogs.some((dialog) => dialog !== null); round++) {
    tasks.shift()?.();
    await pause(10);
  }
  assert.ok(
    dialogs.some((dialog) => dialog !== null),
    "the next step's dialog did not show",
  );
  assert.equal(sends, 1);
  assert.equal(store.size, 1, "the cached locked file stays held");
  assert.ok(store.knows(photo));
});

test("a captured photo the store does not vouch for is released, and the capture answers as unavailable", async (context) => {
  const bridge = await inProcessBridge();
  const store = new CapturedMediaStore(null, urls, "unpublished");
  let session: PlayerSession | null = introduced(
    bridge,
    createPlayerRuntimeSession("let made = takePhoto()\nlet missing = made == null\nexit"),
  );
  const diagnostics: string[] = [];
  const service = new CaptureService(
    async () => ({ kind: "captured", reference: store.add("image", png()).reference }),
    {
      session: () => session,
      generation: () => 1,
      section: serviceSection(
        bridge,
        () => session,
        (next) => (session = next),
      ),
      // The admission table vouches for nothing, so the engine refuses the photo (`invalidPayload`).
      capturedMedia: { holds: () => false, discard: (reference) => store.discard(reference) },
      diagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
      later: (task) => setImmediate(task),
    },
  );
  context.after(() => service.stop());
  service.request();
  await until(() => session?.state.status === "halted", "the capture was not answered");
  await pause();
  assert.deepEqual(diagnostics, ["capture-rejected"]);
  assert.equal(store.size, 0);
});

class Track extends EventTarget implements CaptureTrack {
  readonly kind = "video";
  readonly label = "camera";
  readyState: "live" | "ended" = "live";
  stop() {
    this.readyState = "ended";
  }
}

/** A session camera over a fake browser whose photo encoding waits for `encoded`. */
async function heldEncoding(context: TestContext) {
  const store = new CapturedMediaStore(null, urls, "unpublished");
  const track = new Track();
  const encoding = { started: false, finish: (_data: Blob) => {} };
  const host: CaptureHost<Track> = {
    acquire: async () => [track],
    listDevices: async () => [],
    createRecorder: () => {
      throw new Error("not used");
    },
    grabFrame: async () => new RgbaImage(1, 1, new Uint8ClampedArray([1, 2, 3, 255])),
    encodeImage: () =>
      new Promise<Blob>((resolve) => {
        encoding.started = true;
        encoding.finish = resolve;
      }),
    decodeImage: async () => new RgbaImage(1, 1, new Uint8ClampedArray(4)),
    createAudioSampler: () => {
      throw new Error("not used");
    },
    now: () => 0,
    stateChanged: () => {},
  };
  const camera = new SessionCamera(new CaptureDevice(host, store), () => {});
  context.after(() => camera.release());
  assert.equal(await camera.open(true), true);
  return { store, camera, encoding };
}

for (const released of ["after the device stored it", "while it was encoded"] as const)
  test(`a camera released ${released} keeps no photo`, async (context) => {
    const { store, camera, encoding } = await heldEncoding(context);
    const answering = camera.answer();
    await until(() => encoding.started, "the photo was not encoded");
    if (released === "while it was encoded") camera.release();
    encoding.finish(png());
    // The device stores the photo as its encoding settles; the next microtask releases the camera before the
    // camera's own continuation resumes.
    if (released === "after the device stored it") queueMicrotask(() => camera.release());
    const answer: PlayerCaptureAnswer = await answering;
    assert.deepEqual(answer, { kind: "unavailable", reason: "revoked" });
    assert.equal(store.size, 0);
  });
