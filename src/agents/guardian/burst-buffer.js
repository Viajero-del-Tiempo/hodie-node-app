import { randomUUID } from "node:crypto";
export const systemClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) };
export function createBurstBuffer({ clock = systemClock, config, onBatch, logger = () => {} }) {
  const buffers = new Map();
  const pending = new Map();
  let closed = false;
  function freeze(chatId) {
    const batch = buffers.get(chatId);
    if (!batch) return;
    buffers.delete(chatId);
    clock.clearTimeout(batch.timer);
    batch.closedAt = clock.now();
    batch.status = "queued";
    pending.set(batch.id, batch);
    Promise.resolve().then(() => {
      if (closed) throw Object.assign(new Error("Ráfaga descartada al apagar"), { code: "GUARDIAN_SHUTDOWN" });
      return onBatch(batch);
    }).then(result => batch.waiters.forEach(waiter => waiter.resolve(result)),
      error => batch.waiters.forEach(waiter => waiter.reject(error))).finally(() => pending.delete(batch.id));
  }
  return {
    push(message) {
      if (closed) return Promise.reject(new Error("Buffer cerrado"));
      const now = clock.now();
      let batch = buffers.get(message.from);
      if (batch && now >= batch.deadline) { freeze(message.from); batch = null; }
      if (!batch) {
        batch = { id: randomUUID(), chatId: message.from, firstAt: now, lastAt: now, messages: [], waiters: [], status: "collecting" };
        buffers.set(message.from, batch);
      }
      batch.messages.push(message);
      batch.lastAt = now;
      batch.deadline = Math.min(now + config.silenceMs, batch.firstAt + config.burstMaxMs);
      clock.clearTimeout(batch.timer);
      batch.timer = clock.setTimeout(() => freeze(message.from), batch.deadline - now);
      const promise = new Promise((resolve, reject) => batch.waiters.push({ resolve, reject }));
      promise.catch(() => {});
      return promise;
    },
    close() {
      if (closed) return 0;
      closed = true;
      const discarded = [...buffers.values(), ...[...pending.values()].filter(batch => batch.status === "queued")];
      const error = Object.assign(new Error("Ráfaga descartada al apagar"), { code: "GUARDIAN_SHUTDOWN" });
      for (const batch of discarded) {
        clock.clearTimeout(batch.timer);
        batch.waiters.forEach(waiter => waiter.reject(error));
      }
      buffers.clear();
      logger({ event: "guardian_shutdown", discardedPendingBatches: discarded.length });
      return discarded.length;
    },
    pendingCount: () => buffers.size + [...pending.values()].filter(batch => batch.status === "queued").length,
  };
}
