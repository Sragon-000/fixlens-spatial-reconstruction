// UI animation is not evidence of a new camera frame.
export class FrameGate {
  constructor() { this.reset(); }
  reset() { this.mediaTime = null; this.changedAt = null; }
  sample(video, track, now) {
    if (!track || track.readyState !== 'live' || track.muted || video.paused ||
        video.readyState < 2 || !Number.isFinite(video.currentTime)) {
      this.reset(); return {fresh:false, changed:false};
    }
    const changed = video.currentTime !== this.mediaTime;
    if (changed) { this.mediaTime = video.currentTime; this.changedAt = now; }
    return {changed, fresh:this.changedAt !== null && now - this.changedAt <= 250};
  }
}
