import { randomUUID, createHash } from "node:crypto";

const collections = ["agent_alerts", "order_alerts"];
const titles = { HANDOFF: "atención humana", MISUNDERSTANDING: "consulta sin encauzar", TECHNICAL_FAILURE: "falla técnica",
  TURN_LIMIT: "límite de uso", PAYMENT_RECEIPT: "comprobante por verificar", PDF_DELIVERY_UNCERTAIN: "PDF con entrega incierta",
  WHATSAPP_AUTH_FAILURE: "revisión de la conexión de WhatsApp" };
export function renderTeamAlert(alert) {
  // No enviar contexto, texto libre, nombres, teléfonos, cédula, RUC, importes o URLs.
  const reference = createHash("sha256").update(String(alert.id)).digest("hex").slice(0, 12);
  return `Hay una solicitud de ${titles[alert.type] ?? "revisión del equipo"}. Revisala en el panel. Referencia: ${reference}.`;
}
export function createWhatsAppAlertDispatcher({ db, client, alertsPhone, isReady = () => true, now = Date.now,
  logger = () => {}, leaseMs = 60000, retryBaseMs = 1000, retryMaxMs = 3600000,
  clock = { setTimeout, clearTimeout }, getSignal = () => null }) {
  let closed = false, paused = false, running = null, timer = null, started = false, generation = 0, warned = false;
  const warnIfUnconfigured = () => {
    if (!alertsPhone && !warned) { warned = true; logger({ code: "ALERTS_PHONE_MISSING", message: "Alertas pendientes: falta configurar ALERTS_PHONE." }); }
  };
  const patch = (tx, ref, values) => tx.set(ref, values, { merge: true });
  async function claim(ref) {
    return db.runTransaction(async tx => {
      const doc = await tx.get(ref); if (!doc.exists) return null;
      const alert = { ...doc.data(), id: doc.id }, dispatch = alert.dispatch ?? {};
      if (alert.delivered || ["uncertain", "sent"].includes(dispatch.status) || dispatch.nextAttemptAt > now()) return null;
      if (dispatch.status === "running" && dispatch.leaseUntil > now()) return null;
      if (dispatch.status === "running" && dispatch.phase === "sending") {
        patch(tx, ref, { dispatch: { ...dispatch, status: "uncertain", failureCode: "SEND_UNCERTAIN_AFTER_RESTART" } });
        return null;
      }
      const next = { status: "running", phase: "claimed", token: randomUUID(), leaseUntil: now() + leaseMs, attempts: (dispatch.attempts ?? 0) + 1 };
      patch(tx, ref, { dispatch: next }); return { alert, dispatch: next };
    });
  }
  async function update(ref, token, action) {
    return db.runTransaction(async tx => {
      const doc = await tx.get(ref), alert = doc.data();
      if (!doc.exists || alert.delivered || alert.dispatch?.token !== token || alert.dispatch.status !== "running") return false;
      patch(tx, ref, action(alert.dispatch)); return true;
    });
  }
  async function tick() {
    if (closed || paused || !alertsPhone) return;
    for (const collection of collections) {
      const pending = await db.collection(collection).where("delivered", "==", false).get();
      for (const doc of pending.docs) {
        if (closed || paused) return;
        const job = await claim(doc.ref); if (!job) continue;
        const { alert, dispatch } = job;
        try {
          if (!isReady()) throw Object.assign(new Error("WhatsApp aún no está listo"), { code: "WHATSAPP_NOT_READY", deliveryStarted: false });
          if (closed || paused) throw Object.assign(new Error("Despachador suspendido"), { code: "DISPATCHER_CLOSED", deliveryStarted: false });
          if (!await update(doc.ref, dispatch.token, current => ({ dispatch: { ...current, phase: "sending" } }))) continue;
          if (closed || paused || !isReady()) throw Object.assign(new Error("Despachador suspendido"), { code: "WHATSAPP_NOT_READY", deliveryStarted: false });
          const result = await client.sendMessage(alertsPhone + "@c.us", renderTeamAlert(alert), { sendSeen: false, appOrigin: "alert", appSignal: getSignal() });
          if (!result?.id?._serialized) throw Object.assign(new Error("Envío incierto"), { code: "SEND_UNCERTAIN", deliveryStarted: true });
          await update(doc.ref, dispatch.token, current => ({ delivered: true, deliveredAt: now(),
            dispatch: { ...current, status: "sent", whatsappMessageId: result.id._serialized, leaseUntil: 0 } }));
        } catch (error) {
          const safeRetry = error.deliveryStarted === false;
          await update(doc.ref, dispatch.token, current => ({ dispatch: { ...current, status: safeRetry ? "pending" : "uncertain",
            phase: safeRetry ? "claimed" : "sending", failureCode: error.code ?? "ALERT_SEND_UNCERTAIN", leaseUntil: 0,
            ...(safeRetry ? { nextAttemptAt: now() + Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(current.attempts - 1, 20)) } : {}) } }));
          logger({ code: safeRetry ? "ALERT_RETRY_PENDING" : "ALERT_DELIVERY_UNCERTAIN", collection });
        }
      }
    }
  }
  return {
    warnIfUnconfigured,
    tick() { if (!running) { running = tick().finally(() => { running = null; }); } return running; },
    start() {
      if (closed || started) return;
      if (!alertsPhone) { warnIfUnconfigured(); return; }
      started = true; paused = false;
      const current = ++generation;
      const run = async () => {
        if (closed || paused || current !== generation) return;
        try { await this.tick(); } catch { logger({ code: "ALERT_DISPATCH_FAILED" }); }
        if (!closed && !paused && current === generation) { timer = clock.setTimeout(run, 1000); timer?.unref?.(); }
      };
      void run();
    },
    suspend() { paused = true; started = false; generation++; clock.clearTimeout(timer); },
    async stop() { closed = true; this.suspend(); await running; },
  };
}
