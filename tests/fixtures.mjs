// Synthetic observations for regression tests only; not shipped in dist.
export function demoScene(scenario, milliseconds) {
  const phase = (milliseconds % 5000) / 5000;
  const target = {x: 390, y: 460, w: 300, h: 46};
  const other = {x: 830, y: 460, w: 300, h: 46};
  const destination = scenario === 'wrong' ? other : target;
  const progress = Math.max(0, Math.min(1, (phase - .25) / .45));
  const ram = {x: destination.x + 10, y: 130 + progress * (destination.y - 130), w: 280, h: 42};
  return {ram, target, others: [other], reversed: scenario === 'reversed'};
}
