import { createHash } from "node:crypto";
import { MESSAGE_ID_TTL_MS } from "../config/agent-whatsapp.config.js";
import { normalizePurchasePhone } from "../agents/consultation/order-access.js";

export const AGENT_CHAT_CONTROLS = "agent_chat_controls";
export const chatControlId = chatId => createHash("sha256").update(chatId).digest("hex");
export const maskedChat = chatId => "chat-" + chatControlId(chatId).slice(0, 12);
export const controlError = () => Object.assign(new Error("El estado de atención del chat cambió."), { code: "CHAT_CONTROL_CHANGED", statusCode: 409 });
export function invalidateAgentConfirmations(state) {
  state.lastQuote = null; state.pendingOrderConfirmation = null;
  if (state.pendingTextConfirmation) state.pendingTextConfirmation.shown = false;
  if (state.pendingRucConfirmation) state.pendingRucConfirmation.shown = false;
  return state;
}
export function applyChatControl(state, control) {
  const next = structuredClone(state);
  if ((next.controlGeneration ?? 0) !== control.generation) {
    next.sessionCutoff = next.messages.length;
    next.consecutiveMisunderstandings = 0;
    next.sentProductImages = []; next.pendingOrderReceipt = null;
    invalidateAgentConfirmations(next);
  }
  if (control.paused) invalidateAgentConfirmations(next);
  next.controlGeneration = control.generation;
  next.humanHandoffRequired = control.paused;
  next.humanHandoffReason = control.paused ? control.detail ?? control.reason : null;
  if (!control.paused) next.handoffEpisodeId = null;
  return next;
}

// Autoridad independiente del checkpoint: solo resume() puede quitar la pausa.
export function createAgentChatControl({ db, now = Date.now, timestampFromMillis = value => new Date(value) }) {
  const collection = db.collection(AGENT_CHAT_CONTROLS), ref = chatId => collection.doc(chatControlId(chatId));
  const value = snapshot => {
    if (!snapshot.exists) return null;
    const data = snapshot.data();
    if (data.engine !== "agent" || typeof data.chatId !== "string" || typeof data.paused !== "boolean"
        || !Number.isSafeInteger(data.version) || data.version < 0 || !Number.isSafeInteger(data.generation) || data.generation < 0) {
      throw Object.assign(new Error("Control de chat inválido"), { code: "CHAT_CONTROL_INVALID" });
    }
    return { ...data, id: snapshot.id };
  };
  const assertVersion = (current, expected) => {
    if (!current || current.version !== expected) throw controlError();
  };
  return {
    ref,
    async get(chatId) { return value(await ref(chatId).get()); },
    async findChats(chatId, phone) {
      const exact = value(await ref(chatId).get()), canonical = normalizePurchasePhone(phone);
      const matches = canonical ? (await collection.where("phoneKey", "==", chatControlId(canonical)).get()).docs.map(value) : [];
      return [...new Map([...(exact ? [exact] : []), ...matches].map(item => [item.id, item])).values()];
    },
    async getById(id) { return /^[a-f0-9]{64}$/u.test(id) ? value(await collection.doc(id).get()) : null; },
    async ensure(chatId, phone) {
      return db.runTransaction(async tx => {
        const doc = ref(chatId), existing = await tx.get(doc);
        if (existing.exists) return value(existing);
        const prior = await tx.get(db.collection("handoff_threads").doc(chatId));
        const paused = prior.exists && prior.data().active !== false;
        const canonical = normalizePurchasePhone(phone);
        const control = { chatId, engine: "agent", phoneKey: canonical ? chatControlId(canonical) : null,
          phoneMasked: phone ? "…" + String(phone).slice(-4) : maskedChat(chatId),
          paused, reason: paused ? "derivacion" : null, detail: paused ? prior.data().motivo ?? null : null,
          pausedAt: paused ? prior.data().fecha ?? timestampFromMillis(now()) : null, version: 0, generation: 0,
          lastCustomerMessage: String(prior.data()?.lastCustomerMessage ?? "").slice(0, 200) };
        tx.create(doc, control); return { ...control, id: doc.id };
      });
    },
    async touch(chatId, text) {
      await ref(chatId).set({ lastCustomerMessage: String(text ?? "").slice(0, 200) }, { merge: true });
    },
    async pause(chatId, { reason, detail = null, eventId, expectedVersion, snapshot } = {}) {
      if (!["toma_manual", "derivacion"].includes(reason)) throw new Error("Motivo de pausa inválido");
      return db.runTransaction(async tx => {
        const doc = ref(chatId), existing = await tx.get(doc), current = value(existing);
        if (!current) throw controlError();
        const eventRef = eventId ? db.collection("agent_whatsapp_messages").doc(chatControlId(chatId + ":manual:" + eventId)) : null;
        const event = eventRef ? await tx.get(eventRef) : null;
        const expiry = event?.data()?.expiresAt;
        const expiresAt = expiry?.toMillis?.() ?? new Date(expiry).getTime();
        if (event?.exists && !Number.isFinite(expiresAt)) throw Object.assign(new Error("Evento manual sin vencimiento válido"), { code: "MESSAGE_RECORD_INVALID" });
        if (event?.exists && expiresAt > now()) return { ...current, duplicate: true };
        if (expectedVersion !== undefined) assertVersion(current, expectedVersion);
        const alertWrites = [];
        for (const alert of snapshot?.guardianAlerts ?? []) {
          if (alert.delivered || alert.episodeId !== snapshot.handoffEpisodeId) continue;
          const alertRef = db.collection("agent_alerts").doc(alert.id);
          if (!(await tx.get(alertRef)).exists) alertWrites.push({ ref: alertRef, alert });
        }
        const next = { ...current, paused: true, reason, detail, pausedAt: timestampFromMillis(now()), version: current.version + 1 };
        delete next.id;
        tx.set(doc, next); tx.delete(db.collection("order_confirmations").doc(chatId));
        tx.set(db.collection("handoff_threads").doc(chatId), { engine: "agent", active: true, motivo: reason,
          fecha: next.pausedAt, whatsappChatId: chatId, thread_id: chatId }, { merge: true });
        if (snapshot) tx.set(db.collection("agent_checkpoints").doc(chatId), { snapshot: applyChatControl(snapshot, next), controlVersion: next.version });
        for (const entry of alertWrites) tx.create(entry.ref, entry.alert);
        if (eventRef) tx.set(eventRef, { chatId, messageId: eventId, kind: "manual", expiresAt: timestampFromMillis(now() + MESSAGE_ID_TTL_MS) });
        return { ...next, id: doc.id };
      });
    },
    async resume(id, expectedVersion) {
      return db.runTransaction(async tx => {
        const doc = collection.doc(id), snapshot = await tx.get(doc), current = value(snapshot);
        assertVersion(current, expectedVersion);
        if (!current.paused) throw controlError();
        const next = { ...current, paused: false, reason: null, detail: null, pausedAt: null,
          version: current.version + 1, generation: current.generation + 1, resumedAt: timestampFromMillis(now()) };
        delete next.id;
        tx.set(doc, next); tx.delete(db.collection("order_confirmations").doc(current.chatId));
        tx.set(db.collection("handoff_threads").doc(current.chatId), { engine: "agent", active: false }, { merge: true });
        return { ...next, id };
      });
    },
    async assertActive(tx, chatId, expectedVersion) {
      const current = value(await tx.get(ref(chatId)));
      assertVersion(current, expectedVersion);
      if (current.paused) throw controlError();
    },
    async listPaused() {
      const docs = await collection.where("paused", "==", true).get();
      return docs.docs.map(doc => {
        const data = doc.data(), date = data.pausedAt;
        return { id: doc.id, engine: "agent", phoneMasked: data.phoneMasked, reason: data.reason,
          pausedAt: (date?.toDate?.() ?? new Date(date)).toISOString(), version: data.version,
          lastCustomerMessage: String(data.lastCustomerMessage ?? "").slice(0, 200) };
      }).sort((a, b) => b.pausedAt.localeCompare(a.pausedAt));
    },
    watch(chatId, listener, onError) {
      return ref(chatId).onSnapshot?.(snapshot => {
        try { listener(value(snapshot)); } catch (error) { onError?.(error); }
      }, onError) ?? (() => {});
    },
  };
}
