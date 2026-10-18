import { createAgentRuntime } from "./runtime-factory.js";
import { createWhatsAppAdapter } from "../guardian/whatsapp-adapter.js";
import { createAgentCheckpointStore, createControlledCheckpointStore } from "./checkpoint-store.js";
import { controlError } from "../../services/agent-chat-control.service.js";
import { createCatalogService } from "../../services/catalog.service.js";
import { createCatalogRepository } from "../../services/catalog.repository.js";
import { createCartRepository } from "../../services/cart.repository.js";
import { createOrderQuoteRepository } from "../../services/order-quote.repository.js";
import { createOrderConfirmationRepository } from "../../services/order-confirmation.repository.js";
import { createAgentConfigRepository } from "../../services/agent-config.repository.js";
import { createAgentAlertRepository } from "../../services/agent-alert.repository.js";
import { createAgentAlertService } from "../../services/agent-alert.service.js";
import { createPaymentReceiptRepository } from "../../services/payment-receipt.repository.js";
import { createPrivateReceiptStorage } from "../../services/payment-receipt.storage.js";
import { createSignedImageUploader } from "../../services/cloudinary.service.js";
import { assertCheckpointState } from "../guardian/attachments.js";

export function initialAgentState(chatId) {
  return { whatsappChatId: chatId, messages: [], sessionCutoff: 0, lastActivityAt: null,
    userPhoneNumber: null, phoneVerified: false, pushname: null,
    consecutiveMisunderstandings: 0, consecutiveTechnicalFailures: 0, lastTechnicalFailure: null,
    humanHandoffRequired: false, humanHandoffReason: null, lastQuote: null,
    guardianRateLimit: { admittedAt: [], blocked: false, episodeId: null }, guardianAlerts: [],
    resumeRequestedAt: null, resumeAppliedAt: null };
}

// Puertos reales, pero sin inicializadores: el llamador elige DB, cliente y
// almacenamiento. 7A no inicia trabajador PDF, envío de alertas ni toma humana.
export async function createProductionAgent({ db, chatId, timestampNow, timestampFromMillis, resolvePhone,
  transport, bankConfig, receiptStorage = createPrivateReceiptStorage(), uploadCustomizationImage,
  store, control, now = Date.now, logger = () => {}, signal, ...agentOptions }) {
  signal?.throwIfAborted();
  store ??= await createAgentCheckpointStore({ db, chatId });
  let controlVersion = control ? (await control.get(chatId)).version : null;
  if (control) store = await createControlledCheckpointStore({ db, chatId, control, fallback: store });
  let state = await store.read();
  signal?.throwIfAborted();
  const handoffRef = db.collection("handoff_threads").doc(chatId);
  const missing = !state;
  state ??= initialAgentState(chatId);
  const handoff = await handoffRef.get(); signal?.throwIfAborted();
  if (!control && handoff.exists && handoff.data().active !== false) {
    state.humanHandoffRequired = true;
    state.humanHandoffReason = handoff.data().motivo ?? "Atención humana";
  }
  if (missing || handoff.exists && handoff.data().active !== false) {
    await store.write(state);
  }
  let closed = false, deliverySignal = null, outgoing = [], turnStarted = false, deriving = false;
  let persistence = Promise.resolve();
  const clone = value => structuredClone(value);
  const setState = next => {
    const snapshot = clone(assertCheckpointState(next));
    const write = persistence.catch(() => {}).then(async () => {
      if (closed) throw Object.assign(new Error("Agente cerrado"), { code: "PILOT_CLOSED" });
      if (control && snapshot.humanHandoffRequired && !state.humanHandoffRequired) {
        deriving = true;
        try {
          const paused = await control.pause(chatId, { reason: "derivacion", detail: snapshot.humanHandoffReason, expectedVersion: controlVersion, snapshot });
          controlVersion = paused.version; store.rebase(controlVersion);
        } catch (error) { deriving = false; throw error; }
      }
      await store.write(snapshot); state = clone(snapshot);
    });
    persistence = write.catch(() => {});
    return write;
  };
  const adapter = createWhatsAppAdapter({ chatId, resolvePhone,
    sendText: async (_chat, text) => { await transport.sendText(chatId, text, { signal: deliverySignal,
      origin: deriving && state.humanHandoffRequired ? "handoff" : "agent" }); outgoing.push({ role: "assistant", content: text }); },
    sendImage: async (_chat, value) => { await transport.sendImage(chatId, value); outgoing.push({ role: "assistant", content: value.caption + " [imagen enviada]" }); },
  });
  const documents = snapshot => snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
  const orders = {
    async getByNumber(number) { return documents(await db.collection("orders").where("orderNumber", "==", number).limit(1).get())[0] ?? null; },
    async listByPhone(phone) { return documents(await db.collection("orders").where("userPhoneNumber", "==", phone).orderBy("createdAt", "desc").get()); },
    async listByChat(id) { return documents(await db.collection("orders").where("whatsappChatId", "==", id).get()); },
  };
  const signedUploader = createSignedImageUploader();
  const uploader = uploadCustomizationImage ?? ((file, options) => signedUploader(file, options));
  const ports = { transport: adapter, now, getState: () => clone(state), setState,
    catalog: createCatalogService({ repository: createCatalogRepository(db, { timestampNow }), now }), orders,
    cartRepository: createCartRepository({ db, timestampFromMillis, now,
      beforeTransaction: control ? tx => control.assertActive(tx, chatId, controlVersion) : undefined }), quoteRepository: createOrderQuoteRepository({ db }),
    orderRepository: createOrderConfirmationRepository({ db, timestampNow, now,
      beforeTransaction: control ? tx => control.assertActive(tx, chatId, controlVersion) : undefined }), bankConfig,
    agentConfig: createAgentConfigRepository({ db, timestampNow }),
    alerts: createAgentAlertService({ repository: createAgentAlertRepository({ db }) }),
    receiptRepository: createPaymentReceiptRepository({ db, now }), receiptStorage,
    uploadCustomizationImage: uploader, resolveIdentity: options => adapter.resolveIdentity(options),
    async getOwnProfile(phone) { return documents(await db.collection("users").where("phoneNumber", "==", phone).limit(1).get())[0] ?? null; },
    handoffs: {
      async get(id) { const doc = await db.collection("handoff_threads").doc(id).get(); return doc.exists ? doc.data() : null; },
      async upsert(id, values) { await db.collection("handoff_threads").doc(id).set({ ...values, engine: "agent", fecha: timestampNow() }, { merge: true }); },
      async updateLastMessage(id, values) { await db.collection("handoff_threads").doc(id).set({ lastCustomerMessage: values.lastMessage,
        updatedAt: timestampFromMillis(values.lastMessageAt) }, { merge: true }); },
    },
    recordImageEvent: logger,
    setDeliverySignal: value => { deliverySignal = value; },
    async onTurnStart({ signal }) {
      signal.throwIfAborted(); await persistence; signal.throwIfAborted();
      const current = await store.read(); signal.throwIfAborted();
      if (!current) throw Object.assign(new Error("Checkpoint desaparecido"), { code: "CHECKPOINT_MISSING" });
      state = current; outgoing = []; transport.beginTurn(chatId); turnStarted = true;
    },
    async onTurnEnd(turn) {
      if (closed || !turnStarted) return;
      turnStarted = false;
      const next = clone(state);
      next.messages.push(...turn.messages.map(message => ({ role: "user", content: message.text })), ...outgoing);
      await setState(next); outgoing = [];
    },
  };
  const { guardian, registry, purchase, agent } = await createAgentRuntime({ ports, logger, ...agentOptions });
  if (signal?.aborted) { guardian.shutdown(); adapter.shutdown(); throw signal.reason; }
  adapter.bindGuardian(guardian);
  const shutdown = () => {
    if (closed) return;
    closed = true; adapter.shutdown(); transport.close(); signal?.removeEventListener("abort", shutdown);
  };
  signal?.addEventListener("abort", shutdown, { once: true });
  return { async receive(message) {
      try { return await adapter.receive(message); }
      finally { if (control && deriving && state.humanHandoffRequired) shutdown(); }
    }, registry, purchase, agent,
    ownsPause: version => controlVersion === version && (state.humanHandoffRequired || deriving) || deriving && controlVersion + 1 === version,
    async assertCanSend({ origin } = {}) {
      if (closed) throw controlError();
      if (!control) return;
      const current = await control.get(chatId);
      if (!current || current.version !== controlVersion || current.paused && !(deriving && origin === "handoff" && current.reason === "derivacion")) throw controlError();
    },
    getState: ports.getState,
    shutdown,
  };
}
