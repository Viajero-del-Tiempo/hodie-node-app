import { classifyModelError } from "../../utils/model-usage.util.js";

export const MODEL_CLOCK = { now: () => performance.now(), setTimeout, clearTimeout };
export const DEFAULT_MODEL_CALL_TIMEOUT_MS = 20000;
export const TRANSIENT_RETRY_DELAY_MS = 500;
export function resolveModelCallTimeout(env = process.env, override) {
  const raw = override !== undefined ? override : env.AGENT_MODEL_CALL_TIMEOUT_MS !== undefined
    ? env.AGENT_MODEL_CALL_TIMEOUT_MS : DEFAULT_MODEL_CALL_TIMEOUT_MS;
  const value = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/u.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < 1000 || value > 60000) throw Object.assign(
    new Error("AGENT_MODEL_CALL_TIMEOUT_MS debe ser un entero entre 1000 y 60000."), { code: "INVALID_MODEL_CALL_TIMEOUT" });
  return value;
}

async function cancellable(action, signal) {
  signal.throwIfAborted();
  let listener;
  const cancelled = new Promise((_, reject) => {
    listener = () => reject(signal.reason); signal.addEventListener("abort", listener, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return action(); }), cancelled]); }
  finally { signal.removeEventListener("abort", listener); }
}

async function waitForRetry(clock, milliseconds, signal) {
  signal.throwIfAborted();
  let timer, listener;
  try {
    await new Promise((resolve, reject) => {
      listener = () => reject(signal.reason);
      signal.addEventListener("abort", listener, { once: true });
      timer = clock.setTimeout(resolve, milliseconds);
    });
    signal.throwIfAborted();
  } finally {
    clock.clearTimeout(timer);
    signal.removeEventListener("abort", listener);
  }
}

export function createModelInvoker({ tracker, timeoutMs = DEFAULT_MODEL_CALL_TIMEOUT_MS, clock = MODEL_CLOCK,
  getRemainingMs, onAttempt = () => {}, retryReserveMs = 5000 }) {
  return { async invoke(action, { signal, ...metadata }) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      signal.throwIfAborted();
      const remaining = getRemainingMs();
      if (remaining <= 0) throw Object.assign(new Error("Tiempo del turno agotado."), { code: "AGENT_TIMEOUT" });
      const controller = new AbortController();
      const abort = () => { controller.abort(signal.reason); signal.removeEventListener("abort", abort); };
      signal.addEventListener("abort", abort, { once: true });
      const error = Object.assign(new Error("Tiempo de la llamada al modelo agotado."), { code: "MODEL_CALL_TIMEOUT" });
      const timer = clock.setTimeout(() => controller.abort(error), Math.min(timeoutMs, remaining));
      let succeeded = false, retryError, retryDelayMs;
      try {
        const details = onAttempt(attempt) ?? {};
        const response = await tracker.invoke(() => cancellable(() => action(controller.signal), controller.signal),
          { ...metadata, ...details, attempt });
        signal.throwIfAborted();
        succeeded = true;
        return response;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (!classifyModelError(error).retryable || attempt === 2) throw error;
        retryDelayMs = error.code === "MODEL_CALL_TIMEOUT" ? 0 : TRANSIENT_RETRY_DELAY_MS;
        if (getRemainingMs() < timeoutMs + retryReserveMs + retryDelayMs) {
          error.retrySkipped = "INSUFFICIENT_TURN_TIME"; throw error;
        }
        retryError = error;
      } finally {
        clock.clearTimeout(timer);
        // Una respuesta exitosa no cancela el turno ni los consumidores de su
        // señal. La señal sigue al padre hasta el cierre; el plazo de llamada
        // ya terminó. Los intentos fallidos sí se cancelan y se desconectan.
        if (!succeeded) {
          signal.removeEventListener("abort", abort);
          controller.abort(Object.assign(new Error("Intento cerrado."), { code: "MODEL_ATTEMPT_CLOSED" }));
        }
      }
      // Ya se canceló el intento fallido. La espera pertenece al turno y su
      // cancelación impide iniciar cualquier llamada después del cierre.
      if (retryDelayMs) await waitForRetry(clock, retryDelayMs, signal);
      signal.throwIfAborted();
      if (getRemainingMs() < timeoutMs + retryReserveMs) {
        retryError.retrySkipped = "INSUFFICIENT_TURN_TIME"; throw retryError;
      }
    }
  } };
}
