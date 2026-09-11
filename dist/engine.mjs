// Coordinates are expressed on a 1280 × 720 reference plane.
// Duration-based transitions are independent of screen refresh rate.
export const edgeDistance = (a, b) => Math.hypot(
  ((a.x + a.w / 2) - (b.x + b.w / 2)) * 1.2,
  Math.max(b.y - (a.y + a.h), (a.y + a.h) - (b.y + b.h), 0));

export class AssemblyEngine {
  constructor() { this.reset(); }
  reset() {
    this.state = 'SCAN'; this.warning = ''; this.errors = 0;
    this.scanAt = null; this.holdAt = null; this.lastAt = null;
    this.startedAt = null; this.elapsed = 0; this.progress = 0;
    this.message = 'RAM과 타겟 슬롯의 위치를 확인하세요.';
  }
  update({ram, target, others = [], reversed = false}, now) {
    if (this.startedAt === null) this.startedAt = now;
    if (this.state === 'COMPLETE') return this.snapshot();
    if (this.lastAt !== null && (now - this.lastAt > 250 || now < this.lastAt)) {
      this.scanAt = null; this.holdAt = null; this.state = 'SCAN';
    }
    this.lastAt = now; this.elapsed = Math.max(0, now - this.startedAt);
    const previousWarning = this.warning;
    this.warning = ''; this.progress = 0;
    if (!ram || !target) {
      this.state = 'SCAN'; this.scanAt = null; this.holdAt = null;
      this.message = 'RAM과 타겟 슬롯을 모두 지정하세요.';
    } else if (this.state === 'SCAN') {
      this.scanAt ??= now;
      this.message = '입력 위치를 확인하고 있어요.';
      if (now - this.scanAt >= 160) { this.state = 'GUIDE'; this.message = '초록색 타겟 슬롯으로 RAM을 이동하세요.'; }
    } else {
      const distance = edgeDistance(ram, target);
      const otherDistance = Math.min(Infinity, ...others.map(slot => edgeDistance(ram, slot)));
      if (Math.min(distance, otherDistance) <= 60 && reversed) this.warning = 'REVERSED_RAM';
      else if (otherDistance < distance && otherDistance <= 60) this.warning = 'WRONG_SLOT';
      if (this.warning) {
        if (this.warning !== previousWarning) this.errors++;
        this.state = 'GUIDE'; this.holdAt = null;
        this.message = this.warning === 'REVERSED_RAM' ? '방향 오류 · RAM의 노치 방향을 확인하세요.' : '슬롯 오류 · 초록색 타겟 슬롯으로 이동하세요.';
      } else if (distance > 60) {
        this.state = 'GUIDE'; this.holdAt = null;
        this.message = '초록색 타겟 슬롯으로 RAM을 이동하세요.';
      } else {
        this.state = 'ERROR_CHECK';
        if (distance <= 10) {
          this.holdAt ??= now;
          this.progress = Math.min(1, (now - this.holdAt) / 500);
          this.message = '정상 위치를 잠시 유지하세요.';
          if (this.progress >= 1) {
            this.state = 'COMPLETE';
            this.message = '정상 위치 유지 확인 · 실제 걸쇠 체결은 직접 확인하세요.';
          }
        } else { this.holdAt = null; this.message = 'RAM 하단을 슬롯에 맞춰 정렬하세요.'; }
      }
    }
    return this.snapshot();
  }
  snapshot() { return {state: this.state, warning: this.warning, errors: this.errors, elapsed: this.elapsed, progress: this.progress, message: this.message}; }
}

export function demoScene(scenario, milliseconds) {
  const phase = (milliseconds % 5000) / 5000;
  const target = {x: 390, y: 460, w: 300, h: 46};
  const other = {x: 830, y: 460, w: 300, h: 46};
  const destination = scenario === 'wrong' ? other : target;
  const progress = Math.max(0, Math.min(1, (phase - .25) / .45));
  const ram = {x: destination.x + 10, y: 130 + progress * (destination.y - 130), w: 280, h: 42};
  return {ram, target, others: [other], reversed: scenario === 'reversed'};
}
