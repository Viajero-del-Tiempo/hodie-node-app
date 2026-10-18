import { randomUUID, createHash } from "node:crypto";

const collections = ["agent_alerts", "order_alerts"];
const titles = { HANDOFF: "atención humana", MISUNDERSTANDING: "consulta sin encauzar", TECHNICAL_FAILURE: "falla técnica",
  TURN_LIMIT: "límite de uso", PAYMENT_RECEIPT: "comprobante por verificar", PDF_DELIVERY_UNCERTAIN: "PDF con entrega incierta" };
export function renderTeamAlert(alert) {
  // No enviar contexto, texto libre, nombres, teléfonos, cédula, RUC, importes o URLs.
  const reference = createHash("sha256").update(String(alert.id)).digest("hex").slice(0, 12);
  return `Hay una solicitud de ${titles[alert.type] ?? "revisión del equipo"}. Revisala en el panel. Referencia: ${reference}.`;
}
export function createWhatsAppAlertDispatcher({ db, client, alertsPhone, isReady = () => true, now = Date.now,
  logger = () => {}, leaseMs = 60000, retryBaseMs = 1000, retryMaxMs = 3600000 }) {
  let closed = false, running = null, timer = null;
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
    if (closed || !alertsPhone) return;
    for (const collection of collections) {
      const pending = await db.collection(collection).where("delivered", "==", false).get();
      for (const doc of pending.docs) {
        if (closed) return;
        const job = await claim(doc.ref); if (!job) continue;
        const { alert, dispatch } = job;
        try {
          if (!isReady()) throw Object.assign(new Error("WhatsApp aún no está listo"), { code: "WHATSAPP_NOT_READY", deliveryStarted: false });
          if (closed) throw Object.assign(new Error("Despachador cerrado"), { code: "DISPATCHER_CLOSED", deliveryStarted: false });
          if (!await update(doc.ref, dispatch.token, current => ({ dispatch: { ...current, phase: "sending" } }))) continue;
          if (closed) throw Object.assign(new Error("Despachador cerrado"), { code: "DISPATCHER_CLOSED", deliveryStarted: false });
          const result = await client.sendMessage(alertsPhone + "@c.us", renderTeamAlert(alert), { sendSeen: false, appOrigin: "alert" });
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
    tick() { if (!running) { running = tick().finally(() => { running = null; }); } return running; },
    start() {
      if (!alertsPhone) { logger({ code: "ALERTS_PHONE_MISSING", message: "Alertas pendientes: falta configurar ALERTS_PHONE." }); return; }
      const run = () => { if (!closed) void this.tick().catch(() => logger({ code: "ALERT_DISPATCH_FAILED" })); };
      run(); timer = setInterval(run, 1000); timer.unref?.();
    },
    async stop() { closed = true; clearInterval(timer); await running; },
  };
}
