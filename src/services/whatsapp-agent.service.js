import { createHash } from "node:crypto";
import { acceptsMessage, ALLOWED_MESSAGE_TYPES } from "../agents/guardian/filters.js";
import { allowsAgentPhone } from "../config/agent-whatsapp.config.js";

// Puerta previa al receptor legacy. false significa exclusivamente interruptor
// apagado; un error del piloto nunca autoriza caer al grafo anterior.
export function createWhatsAppPilot({ config, repository, resolvePhone, transport, createRuntime, control, ownMessages, logger = () => {} }) {
  const admissions = new Map(), runtimes = new Map();
  const subscriptions = new Map(), runtimeControllers = new Map(), runtimeVersions = new Map(), pauses = new Map();
  const lifetime = new AbortController();
  let closed = false;
  function cancelChat(chatId) {
    runtimeControllers.get(chatId)?.abort(Object.assign(new Error("Atención humana o sesión nueva"), { code: "CHAT_CONTROL_CHANGED" }));
    runtimeControllers.delete(chatId);
    runtimeVersions.delete(chatId);
    const pending = runtimes.get(chatId); runtimes.delete(chatId);
    pending?.then(runtime => runtime.shutdown()).catch(() => {});
  }
  function watch(chatId, initialVersion) {
    if (!control || subscriptions.has(chatId)) return;
    let version = initialVersion;
    subscriptions.set(chatId, control.watch(chatId, next => {
      if (!next) { cancelChat(chatId); return; }
      if (next.version === version) return;
      version = next.version;
      const pending = runtimes.get(chatId);
      pending?.then(runtime => {
        if (runtimes.get(chatId) !== pending) return;
        if (next.paused && next.reason === "derivacion" && runtime.ownsPause?.(next.version)) return;
        cancelChat(chatId);
      }).catch(() => { if (runtimes.get(chatId) === pending) cancelChat(chatId); });
    }, () => { cancelChat(chatId); logger({ code: "CHAT_CONTROL_WATCH_FAILED" }); }));
  }
  async function admit(message) {
    lifetime.signal.throwIfAborted();
    const chatId = message.from;
    let phone = null;
    const silent = config.maintenanceMode === "silent";
    if (silent) {
      // Resolver antes de reclamar el ID: un chat excluido no deja escrituras.
      // El receptor real respeta sideEffectFree también para la caché de LID.
      try { phone = await resolvePhone(chatId, { sideEffectFree: true }); }
      catch { /* Identidad desconocida: permanece fuera de la lista, con un único log. */ }
      lifetime.signal.throwIfAborted();
      if (!allowsAgentPhone(config, phone)) {
        logger({ code: "MAINTENANCE_SILENT", chat: "chat-" + createHash("sha256").update(chatId).digest("hex").slice(0, 12) });
        return {};
      }
    }
    const id = await repository.claimMessage(chatId, message.id?._serialized);
    if (!id) return {};
    let completion;
    try {
      if (!silent) {
        try { phone = await resolvePhone(chatId); }
        catch { logger({ code: "PHONE_RESOLUTION_FAILED" }); }
      }
      lifetime.signal.throwIfAborted();
      if (!allowsAgentPhone(config, phone)) {
        const notify = await repository.claimMaintenance(chatId);
        completion = notify ? transport.sendText(chatId, config.maintenanceMessage, { origin: "maintenance" }) : Promise.resolve();
      } else {
        if (control) {
          await pauses.get(chatId);
          let current = await control.ensure(chatId, phone);
          watch(chatId, current.version);
          await control.touch(chatId, message.body || "[adjunto]");
          current = await control.get(chatId);
          if (!current) throw Object.assign(new Error("Control de chat desaparecido"), { code: "CHAT_CONTROL_CHANGED" });
          if (current.paused) {
            await repository.finishMessage(id, "completed");
            return {};
          }
          if (runtimes.has(chatId) && runtimeVersions.get(chatId) !== current.version) cancelChat(chatId);
          runtimeVersions.set(chatId, current.version);
        }
        if (!runtimes.has(chatId)) {
          const controller = new AbortController(); runtimeControllers.set(chatId, controller);
          const signal = AbortSignal.any([lifetime.signal, controller.signal]);
          const creating = Promise.resolve().then(() => { signal.throwIfAborted(); return createRuntime(chatId, { signal }); });
          runtimes.set(chatId, creating);
          creating.catch(() => { if (runtimes.get(chatId) === creating) runtimes.delete(chatId); });
        }
        const runtime = await runtimes.get(chatId);
        if (closed) throw Object.assign(new Error("Piloto cerrado"), { code: "PILOT_CLOSED" });
        // No esperar aquí el lote: los próximos mensajes deben poder sumarse.
        completion = runtime.receive(message);
      }
    } catch (error) { await repository.finishMessage(id, "error"); throw error; }
    const finished = Promise.resolve(completion).then(
      async result => { await repository.finishMessage(id, "completed"); return result; },
      async error => { await repository.finishMessage(id, "error"); throw error; });
    finished.catch(() => {});
    return { completion: finished };
  }
  return {
    cancelChat,
    async handleCreated(message) {
      if (!config.enabled || !message.fromMe || closed || !control || !ownMessages) return;
      if (!ALLOWED_MESSAGE_TYPES.has(message.type || "chat")) return;
      const chatId = message.to;
      if (typeof chatId !== "string" || !/@(?:c\.us|lid)$/u.test(chatId) || message.isStatus || message.broadcast) return;
      let phone = null;
      try { phone = await resolvePhone(chatId, { sideEffectFree: true }); } catch { /* No habilita un chat desconocido. */ }
      if (!allowsAgentPhone(config, phone)) return;
      if (await ownMessages.owns(chatId, message.id?._serialized, { phone })) return;
      for (const current of await control.findChats(chatId, phone)) {
        const pause = control.pause(current.chatId, { reason: "toma_manual", eventId: message.id?._serialized });
        pauses.set(current.chatId, pause);
        const result = await pause;
        if (!result.duplicate) cancelChat(current.chatId);
        if (pauses.get(current.chatId) === pause) pauses.delete(current.chatId);
      }
    },
    async handle(message) {
      if (!config.enabled) return false;
      if (closed) throw Object.assign(new Error("Piloto cerrado"), { code: "PILOT_CLOSED" });
      if (!acceptsMessage(message) || !/@(?:c\.us|lid)$/u.test(message.from)
          || message.isStatus || message.broadcast) return true;
      const previous = admissions.get(message.from) ?? Promise.resolve();
      const admitted = previous.catch(() => {}).then(() => admit(message));
      admissions.set(message.from, admitted);
      admitted.finally(() => { if (admissions.get(message.from) === admitted) admissions.delete(message.from); }).catch(() => {});
      const { completion } = await admitted;
      await completion;
      return true;
    },
    async shutdown() {
      if (closed) return;
      if (!config.enabled) { closed = true; return; }
      closed = true; lifetime.abort(Object.assign(new Error("Piloto cerrado"), { code: "PILOT_CLOSED" })); transport.close();
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      for (const controller of runtimeControllers.values()) controller.abort(lifetime.signal.reason);
      await Promise.allSettled([...runtimes.values()].map(async pending => (await pending).shutdown()));
    },
  };
}
