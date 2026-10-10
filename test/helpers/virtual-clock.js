export function createVirtualClock(initialTime = 0) {
  if (!Number.isFinite(initialTime)) throw new Error("Reloj inicial inválido");
  let time = initialTime;
  let sequence = 0;
  const timers = new Map();
  const clock = {
    now: () => time,
    setTimeout(fn, milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("Espera inválida");
      const id = ++sequence;
      timers.set(id, { at: time + milliseconds, fn });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    advance(milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("Avance de reloj inválido");
      const target = time + milliseconds;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        timers.delete(next[0]);
        time = next[1].at;
        next[1].fn();
      }
      time = target;
    },
    async advanceAsync(milliseconds) { clock.advance(milliseconds); await flushMicrotasks(); },
    pendingTimers: () => timers.size,
  };
  return clock;
}
export async function flushMicrotasks() { for (let count = 0; count < 50; count++) await Promise.resolve(); }
