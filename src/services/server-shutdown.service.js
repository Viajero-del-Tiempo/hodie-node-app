// Un segundo de margen respecto de kill_timeout=15000 de PM2.
export const SERVER_SHUTDOWN_TIMEOUT_MS = 14000;

// Registrar antes de initialize(): también cubre un arranque aún sin ready.
// Todos los cierres se INICIAN aunque otro falle o no termine.
export function createServerShutdown({ components, processEvents = process,
  clock = { now: Date.now, setTimeout, clearTimeout }, timeoutMs = SERVER_SHUTDOWN_TIMEOUT_MS,
  exit = code => process.exit(code), logger = value => console.info(JSON.stringify(value)) }) {
  let stopping = false, finished = false, completion;
  const handlers = new Map();
  const detach = () => { for (const [signal, handler] of handlers) processEvents.off(signal, handler); };
  function stop(reason = "shutdown", { failed = false } = {}) {
    if (stopping) return completion;
    stopping = true;
    const startedAt = clock.now(), pending = new Set(Object.keys(components));
    let resolve;
    completion = new Promise(done => { resolve = done; });
    const finish = (code, timedOut) => {
      if (finished) return;
      finished = true; clock.clearTimeout(timer); detach();
      const result = { event: "server_shutdown", code: timedOut ? "SERVER_SHUTDOWN_TIMEOUT" : code ? "SERVER_SHUTDOWN_FAILED" : "SERVER_SHUTDOWN_COMPLETE",
        elapsedMs: Math.max(0, clock.now() - startedAt), pending: [...pending] };
      logger(result); resolve({ ...result, exitCode: code }); exit(code);
    };
    const timer = clock.setTimeout(() => finish(1, true), timeoutMs);
    logger({ event: "server_shutdown", code: "SERVER_SHUTDOWN_STARTED", reason });
    const tasks = Object.entries(components).map(([name, action]) => Promise.resolve().then(action).then(
      () => { pending.delete(name); },
      error => { pending.delete(name); logger({ event: "server_shutdown", code: "SERVER_COMPONENT_CLOSE_FAILED", component: name }); throw error; },
    ));
    void Promise.allSettled(tasks).then(results => finish(failed || results.some(result => result.status === "rejected") ? 1 : 0, false));
    return completion;
  }
  const onSignal = signal => { void stop(signal); };
  // Con on (no once), dos señales del mismo tipo no interrumpen el cierre.
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => onSignal(signal); handlers.set(signal, handler); processEvents.on(signal, handler);
  }
  return { stop, isStopping: () => stopping };
}
