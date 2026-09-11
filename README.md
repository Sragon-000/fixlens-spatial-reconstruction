# FixLens on-device AI camera

The browser captures its own camera. COCO-SSD / lite_mobilenet_v2 performs actual object detection inside a dedicated Web Worker on that device. No frame upload or inference server exists. The public static files include pinned TensorFlow.js 4.22.0, COCO-SSD 2.2.3, WASM binaries and all model weights (about 22 MB total). An initial network download is required; offline availability is not promised.

WASM is preferred, then WebGL, then CPU. No cross-origin isolation is required for single-thread WASM. Camera preview remains on the UI thread. Model inputs are reduced to at most 640×480 while preserving aspect ratio; output boxes are normalized and mapped back to actual video dimensions.

Only one inference may run at a time. Results older than 2 seconds or from a previous camera/visibility/size session are discarded. Boxes expire 650ms after the last accepted result, and disappear immediately on an empty detection result or camera interruption. This version repeatedly detects objects; it does not implement persistent object IDs, RAM orientation, assembly classification or physical insertion checks.

Serve dist/ over HTTPS for phone camera access, or localhost for desktop development.

- Regression tests: node --test tests/*.test.mjs
- Actual model and shipped worker smoke test: node tests/model-smoke.mjs
- Optional reference image input: node tests/model-smoke.mjs PATH_TO_RGBA WIDTH HEIGHT

No browser or phone hardware benchmark is claimed. See REVIEW.md and THIRD_PARTY.md.
