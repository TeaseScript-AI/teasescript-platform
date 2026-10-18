# Instructions

The instruction families that `engine.ts` dispatches to.

- `camera.ts`: showing and hiding the camera view, and `takePhoto()`.
- `functions.ts`: function calls: the call frame, parameters and their defaults, and the return.
- `interaction.ts`: asks, buttons, popups, web addresses, exports, forms, and choices: the request and its UI.
- `loops.ts`: `repeat`, `while`, and `for` rounds, and `break` and `continue`.
- `media.ts`: Stage images, audio, and video.
- `say.ts`: `say`, its staging and pacing, speaker declarations, and the prepared parts of a say.
- `say-staging.ts`: whether a say may stage on copies of only the parts it changes.
- `show-permanent-button.ts`: showing a permanent button.
- `storage-write.ts`: `save` and `delete`.
- `support.ts`: what the engine and the instruction families share.
- `timers.ts`: `wait` and timers.
