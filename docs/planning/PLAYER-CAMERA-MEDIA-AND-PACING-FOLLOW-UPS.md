# Player camera, media, and chat-pacing follow-ups

**Status:** Camera/media direction retained; chat-pacing direction superseded for redesign  
**Related design:** Accepted ADR 0016 and accepted ADR 0017  
**Implementation status:** Not implemented

This file keeps camera, captured-media, time-integrity, and text-output follow-up work in one findable place. The earlier automatic 17-characters-per-second chat-pacing direction is superseded by the owner-selected engine-core/Standard-Library redesign and must not be treated as current implementation guidance. This planning file does not schedule work and does not replace an accepted ADR or canonical API specification.

## Camera capability direction

### Keep one camera stream open

When a package declares and receives camera permission, the player should prefer to keep the selected camera stream open while the package owns that capability instead of repeatedly opening and closing the device for every still image.

Reasons:

- repeated device acquisition can be slow or unreliable on some hardware and drivers;
- a stable stream avoids accumulated open/close failures;
- `takePhoto()` can capture an unpredictable frame without visibly reopening the camera at the exact capture moment;
- the same stream can support preview, still capture, recording, and later motion detection.

The browser or operating system may still display its normal camera-use indicator. The platform does not promise that camera use is invisible; it only avoids revealing the exact `takePhoto()` moment through a new player prompt or stream restart.

The player owns the browser stream. TeaseScript receives engine-managed media references, never raw `MediaStream`, track, device, canvas, or blob objects.

### `askImage(...)`

`askImage(...)` is a mandatory interactive image request and does not return `null` under the earlier API direction.

Expected camera path:

1. show the allowed image sources;
2. the player chooses camera or file when both are allowed;
3. for camera, show a preview and a default five-second countdown;
4. capture a candidate image;
5. show `Use photo` and `Retake`;
6. complete only after the player accepts a valid image.

Expected file path:

1. open the file-picker flow through the required player interaction;
2. validate the selected image;
3. show a preview where appropriate;
4. accept or retry;
5. complete only with a valid image.

A future `countdown` option may override the default. `countdown: 0` means capture immediately after the player chooses the camera path.

Cancelling, rejecting, or failing one attempt keeps the same mandatory input action pending and shows recovery choices. `invalidMessage` and `invalidLlmInstruction` remain available for ordinary author-controlled feedback.

The final public `askImage` composition is subject to accepted ADR 0017: the player workflow may remain one typed capability interaction while an author-facing wrapper and any associated text output live in the Standard Library. The exact split requires a later input/camera decision.

### `takePhoto(...)`

Keep the name `takePhoto`, not `takeImage`, unless a later API decision explicitly supersedes it.

`takePhoto(...)` captures a still frame immediately from the selected active camera stream:

- no source question;
- no preview;
- no countdown;
- no accept/retake step;
- returns an engine-managed image reference or `null` when the capture cannot be completed.

The direct capture is intended for surprise snapshots, periodic checks, motion-related scenes, and other script-controlled camera use.

Do not add `requestImage(...)` merely as a duplicate public convenience name. The generic typed-interaction primitive defined as an architectural boundary by ADR 0017 is not automatically a new TeaseScript API.

## Multiple cameras

### Default camera

Calls without a camera selector use the player's current default camera:

```tease
let photo = takePhoto()
```

A single-camera player needs no role or alias configuration.

### Script roles and player aliases

Camera role names are free package-defined strings, not hardcoded platform values such as only `front` or `side`:

```tease
let roomPhoto = takePhoto(camera: "cornerWatch")
let closePhoto = takePhoto(camera: "closeUp")
```

The player maps those script roles to physical devices. The player may also give connected devices personal aliases. For example:

```text
script role: cornerWatch
player alias: Wide room camera
physical device: USB Camera 2
```

This separates author intent from unstable browser device identifiers and allows the player to replace or remap hardware without editing the package.

### Player-controlled switching

The player may change:

- the default camera;
- the physical device assigned to a script role;
- camera quality within supported device capabilities.

A camera recovery interface should support at least:

```text
Try again
Refresh cameras
Select another camera
Choose file, when allowed by the pending request
```

Automatic device-change detection may refresh the list, but a manual refresh remains necessary.

### First implementation boundary

The first camera implementation supports multiple configured devices but keeps only one active physical camera stream at a time. Switching cameras stops the previous stream and opens the selected stream.

Simultaneous multi-camera streams are deferred. They may later support front/side recording, simultaneous still capture, or multi-angle motion analysis, but they require explicit hardware, browser, performance, privacy, and ownership testing.

## Still images during recording

The selected direction is to support capturing a still frame from the same active camera stream while video recording continues.

```tease
let recording = startVideoRecording()
wait 10 s
let snapshot = takePhoto()
stopVideoRecording(recording)
```

The minimum guarantee is a still frame at the active video-stream resolution without stopping the recording. A browser/device may later offer a higher-quality photographic capture path, but the language contract should not depend on that optional capability.

Capturing from a second physical camera while the first records is part of the deferred simultaneous-camera design.

## Camera ownership and recovery questions

A later camera/media ADR must define:

- when the package acquires camera ownership;
- whether ownership lasts for the entire session or a bounded scene/scope;
- when an idle stream is closed;
- reload, restore, reconnect, and permission-revocation behavior;
- switching latency and what `takePhoto()` returns during a switch;
- quality negotiation and default resolution;
- active recording plus still-capture ownership;
- cleanup on `goto`, `run`, `call`, `end`, `exit`, navigation, and fatal player failure;
- privacy indicators and user-visible camera status;
- package-manifest capability declarations and permission UX;
- motion-detection ownership, sampling frequency, and resource limits.

## Captured-media lifetime

### Candidate captures

An `askImage(...)` candidate shown for accept/retake is not yet a TeaseScript value. Choosing `Retake` may delete that candidate immediately.

Only an accepted image receives an engine-managed media reference and becomes runtime-visible.

### Session-scoped media

A captured or selected image is session-scoped by default:

- variables and runtime/UI resources may reference it during the session;
- checkpoints preserve a stable engine-managed reference, not raw bytes or browser objects;
- overwriting one variable does not prove that no other runtime or UI owner still references the media;
- the first implementation may retain session-scoped media until session cleanup rather than implementing fragile immediate reference counting;
- non-persistent session media is removed after the session and its retained checkpoints no longer require it.

Later garbage collection may reclaim unreferenced session media only after complete reachability rules cover variables, scopes, temporaries, pending actions, displayed media, edits, handlers, checkpoints, and persistence operations.

### Persistent media and named collections

Persistent photo storage is required as a separate future feature. Authors need more than an opaque saved string: they need stable identity, organization, and retrieval.

The later design should support concepts equivalent to:

- save one media reference persistently;
- assign a developer-chosen collection or folder such as `introduction-smiles`;
- attach a display name or label;
- retain capture time and other platform metadata;
- retrieve the newest, previous, oldest, random, or matching media item;
- list a collection for galleries or later scene use;
- distinguish immutable stable identity from editable labels and filenames;
- define duplicate names and ordering;
- define account visibility, encryption, retention, deletion, export, moderation, quotas, and package access;
- keep original and edited-copy relationships explicit.

Illustrative intent only:

```tease
let photo = askImage("Smile for your introduction photo")

// Exact future API remains open.
saveMedia(
    media: photo,
    collection: "introduction-smiles",
    name: `${player.alias}-${getDateTime()}`
)
```

A later retrieval API should make scenarios such as "show the most recent introduction photo" or "show the previous photo from this collection" straightforward. The exact function names and data types are not accepted by this planning file.

## Time integrity follow-up

ADR 0016 selects an injected nondecreasing active-session time line, with a monotonic browser clock as the normal active-page source and server anchoring at suitable lifecycle or communication boundaries.

The player should record typed time-integrity diagnostics such as:

```text
normal
suspicious
unverified
```

Possible reasons include:

```text
wallClockJumpForward
wallClockJumpBackward
serverOffsetChanged
monotonicSleepMismatch
serverUnavailable
```

The first use is debugging, diagnostics, and server logging. A time anomaly is not automatically proof of cheating.

A future hook may allow a package to react to a time-integrity event, but the event syntax, permissions, severity threshold, privacy rules, and gameplay semantics remain open. Do not add an automatic cheating popup or punishment before that design is accepted.

Long-running sentences, assignments, or personality deadlines that must resist local clock manipulation belong to future Laravel-authoritative scheduling rather than an open browser `wait` alone.

## Text output and chat pacing redesign

### Superseded direction

The earlier recommendation that every `say` establish an automatic next-message deadline at exactly 17 visible characters per second is no longer the owner-selected direction. Closed draft PR #71 documents that historical proposal but must not be merged or used as an implementation contract.

Accepted ADR 0017 establishes the architecture-first boundary:

- the engine should expose a minimal typed text-output primitive;
- `say` should be considered an author-facing Standard Library composition where practical;
- all visible chat messages may share one output target while retaining stable speaker identity;
- output and later input results must retain enough provenance to support transcript history and selectively separated future LLM contexts;
- exact pacing modes and their interaction with choices, input, waits, and later `say` calls require separate detailed design.

### Candidate output boundary

Conceptually, the core output event may need:

```text
text
target
speakerId
participantSpeakerIds or equivalent conversation provenance
```

The exact schema remains open. The participant collection cannot contain duplicates, but a participant set alone may not uniquely identify every long-running conversation. The later design must decide whether a separate conversation identity is also needed.

Speaker display name, color, avatar, relationships, personality prompts, LLM model selection, memory, summaries, and context assembly remain outside the deterministic engine. The engine records stable IDs and typed events; later platform/LLM layers interpret them.

### Standard Library composition

Candidate Standard Library behavior includes:

- default chat target selection;
- current or explicit speaker selection;
- author-friendly `say` calls and accepted syntax adapters;
- future smart, timed, autoplay, or instant pacing policies;
- transcript-oriented defaults and optional custom output targets.

No detailed pacing API is accepted by this planning update. In particular, it does not restore the automatic 17-characters-per-second proposal.

## Timed-work redesign

Closed draft PR #69 remains historical reference material for deterministic ordering, handles, checkpointing, due-handler queues, and cleanup. Its `startTimer`/`stopTimer` first-slice API and its decision to defer pause/resume are not current owner-selected direction.

The next timer design should start from minimal core capabilities:

- one foreground delay primitive for blocking execution;
- one background timed-work primitive whose handler may become eligible while the main path continues;
- explicit pause, resume, and stop lifecycle semantics for active background timed work;
- separate decisions for restart-after-stop, repetition, persistence, visible countdown presentation, mystery presentation, and author-facing names.

The accepted V30 syntax remains authoritative until a later accepted ADR explicitly supersedes it. This planning update changes design direction, not accepted syntax.

## Suggested follow-up sequence

1. Use accepted ADR 0017 as the engine-primitives and Standard Library boundary.
2. Preserve ADR 0016 as the deterministic pending-action and time foundation; implement its blocking-delay slice with the internal placement documented explicitly.
3. Define Standard Library linkage, generated declarations, editor metadata, versioning, and package-library reuse.
4. Select a small tested Standard Library POC slice, potentially including `say`, acknowledgement, `askText`, `askNumber`, and `choose`.
5. Redesign chat output, speaker/participant provenance, and pacing on the accepted layer boundary.
6. Redesign background timed work and the public timer lifecycle API on the same boundary.
7. Design package camera capability declarations and long-lived stream ownership.
8. Implement image interactions and direct capture on the shared typed action/capability boundary.
9. Design persistent media collections, naming, retrieval, privacy, and retention.
10. Design motion detection and optional multi-camera concurrency.
11. Decide whether time-integrity hooks become script-visible.

## Explicitly deferred decisions

- exact core capability names and public TypeScript interfaces;
- Standard Library linkage, packaging, metadata, and compatibility policy;
- final `say` API, official syntax lowering, pacing modes, and skip behavior;
- exact output-target, speaker, participant, and conversation provenance schema;
- generic typed-interaction schema and public `ask...` wrappers;
- final timer names, handles, pause/resume/stop/restart semantics, repetition, persistence, and UI;
- exact package-manifest syntax for camera, microphone, and file capabilities;
- exact camera-role declaration syntax and whether undeclared role strings are permitted;
- active-stream idle timeout and scope ownership;
- simultaneous camera limits;
- video-recording APIs and handles;
- motion-detection APIs and thresholds;
- persistent `saveMedia` and retrieval syntax;
- media collection schema, naming collisions, indexing, encryption, retention, and quotas;
- script-visible time-integrity hook syntax;
- browser E2E framework selection.
