# Player camera, media, and time-integrity follow-ups

- **Status:** Active non-implemented planning
- **Authority:** Non-authoritative owner-selected direction; accepted ADRs and current topic documents control
- **Use when:** Planning camera ownership, image acquisition, captured-media lifetime, or browser time integrity
- **Do not use for:** Chat pacing, the public timer API, accepted interaction semantics, or current implementation
  status

This file covers only camera, media, and time integrity. Chat pacing and timer foundations are owned by ADRs
0016–0018, current topic documents, and `TIMER-AND-RECOVERY-FOLLOW-UPS.md`. This planning does not schedule
implementation or accept final TeaseScript APIs.

## Camera ownership

When a package declares and receives camera permission, the Player should prefer to keep the selected stream open while
the package owns that capability instead of reopening the device for every capture. The browser or operating system may
still display its normal camera-use indicator. The Player owns browser streams and gives TeaseScript only validated,
engine-managed media references.

A camera/media decision must define:

- package capability declarations and permission UX;
- acquisition, idle close, switching, revocation, reload, restore, reconnect, and fatal-failure behavior;
- quality negotiation and default resolution;
- cleanup across `goto`, `run`, `call`, `end`, `exit`, navigation, and session shutdown;
- privacy indicators and player-visible camera status;
- recording, still capture, motion detection, sampling, and resource limits.

## Interactive and direct image capture

The [accepted V30 baseline](../specifications/accepted-syntaxes-v30.md) defines mandatory `askImage(...)` and nullable
direct `takePhoto(...)`; this planning does not redefine their names or return contracts. The remaining Player design
must decide source selection, preview, countdown, accept/retake, validation, permission, retry, and recovery behavior. A
rejected preview candidate is not runtime-visible.

`takePhoto(...)` should use the selected active stream without a source question or interactive acceptance flow. Its
camera options, transcript behavior, and Standard Library composition require a later accepted camera decision.

## Multiple cameras

A single-camera player needs no role configuration. Packages may later declare free-form camera roles that players map
to physical devices or personal aliases. Calls without a selector use the player's current default camera.

The first implementation should support multiple configured devices while keeping only one physical stream active at a
time. Switching stops the previous stream and opens the selected stream. Simultaneous streams require separate browser,
hardware, performance, privacy, and ownership evidence.

A recovery interface should support retry, device refresh, another device, and file fallback when the pending request
allows it. Device identifiers are not stable author-facing identity.

## Still images during recording

The selected direction is to permit a still frame from the active recording stream without stopping that recording. The
minimum guarantee is the active stream resolution. Higher-quality photographic capture is optional device capability and
must not become a required language guarantee. Capturing from another physical camera belongs to the deferred
simultaneous-camera design.

## Captured-media lifetime

A preview candidate is not runtime-visible until accepted. Retaking may delete the candidate immediately.

Accepted or directly captured media is session-scoped by default:

- runtime and UI state reference stable engine-managed identity rather than raw bytes or browser objects;
- checkpoints preserve that identity and the storage needed to restore it;
- overwriting one variable does not establish that the media is unreachable elsewhere;
- the first implementation may retain session media until session cleanup instead of introducing incomplete reference
  counting;
- later reclamation requires complete reachability across variables, scopes, temporaries, actions, views, edits,
  handlers, checkpoints, and persistence.

Persistent media requires a separate platform design for stable identity, collections, labels, ordering, retrieval,
visibility, encryption, retention, deletion, export, moderation, quotas, package access, and original/edited-copy
relationships. Exact save and retrieval APIs remain open.

## Time integrity

ADR 0016 provides injected nondecreasing active-session time. Browser lifecycle and communication boundaries may also
need server anchoring and typed diagnostics for clock jumps, offset changes, sleep mismatches, or unavailable server
evidence. An anomaly is diagnostic evidence, not automatic proof of cheating.

Long-running assignments, sentences, or personality deadlines that must resist local manipulation belong to future
Laravel-authoritative scheduling rather than an open browser wait alone. Any script-visible time-integrity hook requires
a separate decision covering event shape, permissions, privacy, severity, and gameplay semantics.

## Remaining design questions

- exact camera and file capability declarations;
- role declaration, default selection, switching, and idle ownership;
- image interaction and direct-capture API shapes;
- recording and still-capture handles;
- simultaneous camera limits;
- motion-detection APIs and resource bounds;
- session media storage and complete reachability;
- persistent collections, indexing, privacy, retention, and quotas;
- browser lifecycle and server time anchoring;
- whether time-integrity diagnostics ever become script-visible.
