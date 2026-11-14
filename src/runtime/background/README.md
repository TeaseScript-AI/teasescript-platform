# Background

The background actions a script starts: timers, media, and permanent buttons.

- `timers.ts`: timer state and handles.
- `timer-validation.ts`: restore validation of timers and their queued blocks, and whether catch-up is paused.
- `media.ts`: audio and video playback state.
- `media-validation.ts`: restore validation of media, its handles, and its cue blocks.
- `media-projection.ts`: what a Player needs to play one media instance.
- `exact-interpolation.ts`: exact interpolation of media positions.
- `permanent-buttons.ts`: permanent buttons.
- `permanent-button-validation.ts`: restore validation of permanent buttons and their blocks.
