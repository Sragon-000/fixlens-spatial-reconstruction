# FixLens web prototype

Static browser application. Serve `dist/` over HTTPS for phone camera access, or localhost for desktop development. No dependencies, video uploads, inference API, or persistence.

Run engine regressions with `node --test tests/engine.test.mjs`.

The camera view uses manually entered rectangles and orientation. These do not track real parts. The 500ms completion timer confirms only manually entered geometry, never physical insertion. Fixed thresholds use a 1280×720 reference plane. Camera switching, permission errors, stream termination and page exit release/reset input.

The engine is a duration-based port of the Python prototype rules. Demo and manual input share the same observation contract; future local or remote detectors can supply `{ram, target, others, reversed}` with fresh timestamps. No server inference is implemented in this version.
