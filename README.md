# FixLens web prototype

Static browser application. Serve `dist/` over HTTPS for phone camera access, or localhost for desktop development. No dependencies, video uploads, inference API, or persistence.

Run engine regressions with `node --test tests/*.test.mjs`.

The camera view uses manually entered rectangles and orientation. These do not track real parts. The 500ms completion timer confirms only manually entered geometry, never physical insertion. Fixed thresholds use a 1280×720 reference plane. Camera switching, permission errors, stream termination and page exit release/reset input.

The default screen connects the device camera after a user gesture and permission grant. No demo controls or generated observations are included in the published assets.

The engine is a duration-based port of the Python prototype rules. Only live camera with manual position input is exposed. Synthetic observations exist only in test fixtures; future local or remote detectors can supply `{ram, target, others, reversed}` with fresh timestamps. No server inference is implemented in this version.

Camera processing is gated on advancing video.currentTime, readyState, live track state and mute state. A pause, hidden page or >250ms without new video frames interrupts pending completion. Video dimension changes clear manual boxes to prevent misaligned coordinates. This does not extract objects from video pixels. See REVIEW.md for the current review scope.
