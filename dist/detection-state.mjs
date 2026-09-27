const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function boxIou(a, b) {
  const area = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return area / (a.w * a.h + b.w * b.h - area || 1);
}

function centerDistance(a, b) {
  return Math.hypot(a.x + a.w / 2 - b.x - b.w / 2, a.y + a.h / 2 - b.y - b.h / 2);
}

function normalizedDetection(prediction, width, height, now) {
  if (!Array.isArray(prediction.bbox) || prediction.bbox.length !== 4
    || !prediction.bbox.every(Number.isFinite) || !Number.isFinite(prediction.score) || prediction.score < .35) return null;
  const [x, y, w, h] = prediction.bbox;
  const left = clamp(x / width, 0, 1);
  const top = clamp(y / height, 0, 1);
  const right = clamp((x + w) / width, left, 1);
  const bottom = clamp((y + h) / height, top, 1);
  if (right <= left || bottom <= top) return null;
  return {
    name: String(prediction.class), score: prediction.score,
    x: left, y: top, w: right - left, h: bottom - top,
    lastSeenAt: now, held: false, trackId: null, trackConfidence: 0, trackAmbiguous: false,
  };
}

function associationScore(detection, previous) {
  if (detection.name !== previous.name) return null;
  const iou = boxIou(detection, previous);
  const distance = centerDistance(detection, previous);
  // A held track can reconnect after hand occlusion, but a long jump is marked ambiguous.
  const maxDistance = previous.held ? .45 : .20;
  if (iou < .04 && distance > maxDistance) return null;
  const distanceScale = previous.held ? .45 : .24;
  return { score: iou * .72 + Math.max(0, 1 - distance / distanceScale) * .28, iou, distance };
}

export class DetectionState {
  constructor() {
    this.epoch = 0;
    this.sequence = 0;
    this.trackSequence = 0;
    this.pending = null;
    this.clear();
  }

  clear() {
    this.epoch++;
    this.results = [];
    this.receivedAt = -Infinity;
    this.capturedAt = -Infinity;
  }

  seed(objects, now = performance.now()) {
    this.results = objects.map((object, index) => ({
      name: String(object.detectorName || object.sourceName || object.name),
      score: Number.isFinite(object.score) ? object.score : 1,
      ...object.box,
      lastSeenAt: now,
      held: false,
      trackId: object.trackId || `object-${++this.trackSequence}-${index + 1}`,
      trackConfidence: 1,
      trackAmbiguous: false,
    }));
    this.receivedAt = now;
    this.capturedAt = now;
    return this.results;
  }

  begin(now, width, height) {
    if (this.pending) return null;
    this.pending = { id: ++this.sequence, epoch: this.epoch, capturedAt: now, width, height };
    return { ...this.pending };
  }

  accept(message, now) {
    if (!this.pending || message.id !== this.pending.id) return false;
    const job = this.pending;
    this.pending = null;
    if (job.epoch !== this.epoch || now - job.capturedAt > 2000) return false;

    const previous = now - this.receivedAt <= 1000 ? this.results : [];
    const detections = (message.results || [])
      .map((prediction) => normalizedDetection(prediction, job.width, job.height, now))
      .filter(Boolean);

    const pairs = [];
    detections.forEach((detection, detectionIndex) => {
      previous.forEach((track, trackIndex) => {
        const association = associationScore(detection, track);
        if (association) pairs.push({ detectionIndex, trackIndex, ...association });
      });
    });

    const matches = new Map();
    const usedTracks = new Set();
    pairs.sort((a, b) => b.score - a.score);
    for (const pair of pairs) {
      if (matches.has(pair.detectionIndex) || usedTracks.has(pair.trackIndex)) continue;
      matches.set(pair.detectionIndex, pair);
      usedTracks.add(pair.trackIndex);
    }

    const assigned = detections.map((detection, detectionIndex) => {
      const match = matches.get(detectionIndex);
      if (!match) {
        return {
          ...detection,
          trackId: `object-${++this.trackSequence}`,
          trackConfidence: 0,
          trackAmbiguous: false,
        };
      }
      const prior = previous[match.trackIndex];
      const alternatives = pairs
        .filter((pair) => pair.detectionIndex === detectionIndex && pair.trackIndex !== match.trackIndex)
        .sort((a, b) => b.score - a.score);
      const ambiguous = (alternatives.length > 0 && match.score - alternatives[0].score < .10)
        || (prior.held && match.distance > .18);
      return {
        ...detection,
        x: detection.x * .8 + prior.x * .2,
        y: detection.y * .8 + prior.y * .2,
        w: detection.w * .8 + prior.w * .2,
        h: detection.h * .8 + prior.h * .2,
        trackId: prior.trackId,
        trackConfidence: clamp(match.score, 0, 1),
        trackAmbiguous: ambiguous,
      };
    });

    if (detections.length) {
      previous.forEach((track, index) => {
        if (usedTracks.has(index) || now - track.lastSeenAt > 800) return;
        if (detections.some((detection) => boxIou(detection, track) > 0)) return;
        assigned.push({ ...track, held: true, trackConfidence: Math.max(0, track.trackConfidence * .7) });
      });
    }

    this.results = assigned.slice(0, 50);
    this.receivedAt = now;
    this.capturedAt = job.capturedAt;
    return true;
  }

  visible(now) {
    return now - this.receivedAt <= 650 && now - this.capturedAt <= 2000
      ? this.results.filter((item) => !item.held || now - item.lastSeenAt <= 800)
      : [];
  }
}
