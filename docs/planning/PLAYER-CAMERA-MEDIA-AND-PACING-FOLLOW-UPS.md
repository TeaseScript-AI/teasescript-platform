# Player camera, media, and chat-pacing follow-ups

**Status:** Owner-selected direction and deferred design work  
**Related design:** ADR 0016  
**Implementation status:** Not implemented

This file keeps the camera, captured-media, time-integrity, and chat-pacing decisions discussed alongside the pending-action contract in one findable place. It does not schedule the work and does not replace a later accepted ADR or canonical API specification.

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

`askImage(...)` is a mandatory interactive image request and does not return `null`.

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

### `takePhoto(...)`

Keep the name `takePhoto`, not `takeImage`.

`takePhoto(...)` captures a still frame immediately from the selected active camera stream:

- no source question;
- no preview;
- no countdown;
- no accept/retake step;
- returns an engine-managed image reference or `null` when the capture cannot be completed.

The direct capture is intended for surprise snapshots, periodic checks, motion-related scenes, and other script-controlled camera use.

Do not add `requestImage(...)`. The accepted direction keeps the API surface centered on the existing mandatory `askImage(...)` and optional direct `takePhoto(...)` behaviors.

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

## Chat-output pacing

### Problem

Several consecutive `say` instructions currently produce output as fast as runtime execution permits. The player needs deterministic reading space between chat messages without unnecessarily delaying unrelated buttons, images, captures, or other actions.

### Recommended direction

Do not make every `say` block every later instruction. Instead, pace the chat-output channel:

1. a `say` event is emitted when the chat channel is available;
2. the rendered text establishes the earliest time at which the next `say` may be emitted;
3. unrelated non-`say` instructions may execute immediately;
4. when execution reaches another `say` before the channel is available, that second `say` creates or uses a foreground presentation delay;
5. after the deadline, the second `say` emits and establishes its own next-message deadline.

This produces the intended distinction:

```tease
say "Hold still."
takePhoto()
showButton("Continue")
say "Good."
```

The camera capture and button may become available immediately after the first message. Only the second chat message is prevented from replacing or following the first too quickly.

When an author intends to delay every later action, the author writes an ordinary blocking `wait` statement explicitly.

### Reading speed and override

The automatic pace uses the final visible rendered text at exactly 17 visible characters per second.

The selected parameter name is `wait`:

```tease
say(
    text: "Kneel.",
    wait: 5 s
)
```

Semantics:

```text
wait omitted -> automatic next-say gate at 17 visible characters per second
wait: duration -> exact author-supplied next-say gate
wait: 0 -> no next-say delay
```

The `wait` value controls only when another `say` may emit. It does not implicitly block unrelated instruction kinds.

The eventual specification must define visible-character counting for interpolation, selected list text, whitespace, line breaks, emoji, and combined Unicode graphemes. It must also define checkpoint/restore state for an active chat gate and whether a new speaker shares the same global chat channel. The recommended default is one paced transcript channel, independent of speaker.

This pacing model is a post-V30 change and needs its own accepted syntax/runtime update before implementation. It is intentionally not part of the first blocking-`wait` slice.

## Suggested follow-up sequence

1. Accept and implement ADR 0016 slice 1: blocking `wait`.
2. Implement chat-channel pacing as the second foreground use of timed pending state.
3. Implement one-shot non-persistent background timer.
4. Complete the accepted timer family.
5. Design package camera capability declarations and long-lived stream ownership.
6. Implement `askImage(...)` and `takePhoto(...)` on the shared typed action/capability boundary.
7. Design persistent media collections, naming, retrieval, privacy, and retention.
8. Design motion detection and optional multi-camera concurrency.
9. Decide whether time-integrity hooks become script-visible.

## Explicitly deferred decisions

- exact package-manifest syntax for camera, microphone, and file capabilities;
- exact camera-role declaration syntax and whether undeclared role strings are permitted;
- active-stream idle timeout and scope ownership;
- simultaneous camera limits;
- video-recording APIs and handles;
- motion-detection APIs and thresholds;
- persistent `saveMedia` and retrieval syntax;
- media collection schema, naming collisions, indexing, encryption, retention, and quotas;
- script-visible time-integrity hook syntax;
- exact chat grapheme counting and transcript-channel rules;
- browser E2E framework selection.
