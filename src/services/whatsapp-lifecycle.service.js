import { randomUUID } from "node:crypto";

const unavailable = code => Object.assign(new Error("WhatsApp no está disponible"), { code, deliveryStarted: false });
// Los listeners son síncronos al cerrar la admisión; el almacenamiento va después.
export function createWhatsAppLifecycle({ client, workers = [], onSuspend = () => {}, onReady = () => {},
  requestAlert = async () => {}, recordAck = async () => {}, logger = () => {},
  clock = { setTimeout, clearTimeout }, now = Date.now, retryBaseMs = 5000, retryMaxMs = 300000 }) {
  let state = "starting", attempt = 0, timer = null, initializing = null, stopped = false;
  let connection = new AbortController(), authEpisode = null, alertTimer = null, alertPending = null;
  const log = (code, extra = {}) => logger({ event: "whatsapp_connection", code, ...extra });
  const cancelRetry = () => { clock.clearTimeout(timer); timer = null; };
  function suspend(code) {
    connection.abort(unavailable(code));
    onSuspend();
    for (const worker of workers) worker.suspend();
  }
  function schedule() {
    if (stopped || state === "auth_failed" || state === "ready" || timer !== null) return;
    const waitMs = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(attempt++, 20));
    log("WHATSAPP_RECONNECT_SCHEDULED", { attempt, waitMs });
    timer = clock.setTimeout(() => { timer = null; void connect(true); }, waitMs); timer?.unref?.();
  }
  async function connect(reconnecting = false) {
    if (stopped || state === "auth_failed" || state === "ready" || initializing) return initializing;
    initializing = (async () => {
      try {
        if (reconnecting) await client.destroy(); // Cierra Chromium; nunca logout ni borra LocalAuth.
        if (stopped || state === "auth_failed") return;
        await client.initialize();
      } catch { if (!stopped && state !== "auth_failed") { state = "disconnected"; log("WHATSAPP_INITIALIZE_FAILED"); } }
    })();
    try { await initializing; }
    finally {
      initializing = null;
      if (stopped) { try { await client.destroy(); } catch { log("WHATSAPP_CLOSE_FAILED"); } }
      else if (state === "disconnected") schedule();
    }
  }
  const handlers = {
    authenticated() {
      if (stopped || state === "auth_failed" || state === "ready") return;
      cancelRetry(); state = "authenticated"; log("WHATSAPP_AUTHENTICATED");
    },
    ready() {
      if (stopped || state === "auth_failed") return;
      if (state === "ready") return;
      cancelRetry(); state = "ready"; attempt = 0;
      if (connection.signal.aborted) connection = new AbortController();
      onReady(); for (const worker of workers) worker.start(); log("WHATSAPP_READY");
    },
    auth_failure() {
      if (stopped || state === "auth_failed") return;
      state = "auth_failed"; cancelRetry(); suspend("WHATSAPP_AUTH_FAILURE"); log("WHATSAPP_AUTH_FAILURE");
      authEpisode ??= randomUUID();
      const alert = { id: "whatsapp-auth-" + authEpisode, type: "WHATSAPP_AUTH_FAILURE", createdAt: now(), delivered: false };
      const persist = async (retry = 0) => {
        try { await requestAlert(alert); }
        catch {
          log("WHATSAPP_AUTH_ALERT_PERSIST_FAILED");
          if (!stopped) { alertTimer = clock.setTimeout(() => { alertPending = persist(retry + 1); }, Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(retry, 20))); alertTimer?.unref?.(); }
        }
      };
      alertPending = persist();
    },
    disconnected(reason) {
      if (stopped || state === "auth_failed") return;
      state = "disconnected"; suspend("WHATSAPP_DISCONNECTED");
      log("WHATSAPP_DISCONNECTED", { reason: ["LOGOUT", "CONFLICT", "UNPAIRED", "UNPAIRED_IDLE", "TIMEOUT", "NAVIGATION"].includes(reason) ? reason : "OTHER" });
      if (!initializing) schedule();
    },
    message_ack(message, ack) {
      if (stopped || !message?.fromMe || !message.id?._serialized || !Number.isInteger(ack) || ack < -1 || ack > 4) return;
      void recordAck(message.to, message.id._serialized, ack).catch(() => log("WHATSAPP_ACK_RECORD_FAILED"));
    },
  };
  for (const [event, listener] of Object.entries(handlers)) client.on(event, listener);
  return { isReady: () => state === "ready" && !stopped, getSignal: () => connection.signal, getState: () => state,
    start: () => connect(),
    async stop() {
      if (stopped) return;
      stopped = true; state = "stopped"; cancelRetry(); suspend("WHATSAPP_STOPPED");
      clock.clearTimeout(alertTimer);
      for (const [event, listener] of Object.entries(handlers)) client.off(event, listener);
      await Promise.allSettled(workers.map(worker => worker.stop()));
      await alertPending;
    },
  };
}
