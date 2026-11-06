export const MEMORY_LOG_INTERVAL_MS = 10 * 60 * 1000;
export function readMemoryWarnMb(env = process.env) {
  const raw = env.MEMORY_WARN_MB ?? "700";
  if (!/^[0-9]+$/u.test(String(raw)) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) {
    throw new Error("MEMORY_WARN_MB debe ser un entero positivo en MB");
  }
  return Number(raw);
}
export function createProcessMemoryMonitor({ warnMb = readMemoryWarnMb(), memoryUsage = () => process.memoryUsage(),
  clock = { setTimeout, clearTimeout }, logger = value => console.info(JSON.stringify(value)) } = {}) {
  if (!Number.isSafeInteger(warnMb) || warnMb < 1) throw new Error("MEMORY_WARN_MB debe ser un entero positivo en MB");
  let timer, running = false;
  const sample = () => {
    const { rss, heapUsed } = memoryUsage();
    logger({ event: "process_memory", code: rss > warnMb * 1024 * 1024 ? "MEMORY_WARN" : "MEMORY_SAMPLE",
      level: rss > warnMb * 1024 * 1024 ? "warn" : "info", rss, heapUsed, warnMb });
  };
  const poll = () => { if (!running) return; sample(); timer = clock.setTimeout(poll, MEMORY_LOG_INTERVAL_MS); timer?.unref?.(); };
  return { start() { if (running) return; running = true; poll(); },
    stop() { running = false; clock.clearTimeout(timer); } };
}
