import { acceptsMessage } from "../agents/guardian/filters.js";
import { allowsAgentPhone } from "../config/agent-whatsapp.config.js";

// Puerta previa al receptor legacy. false significa exclusivamente interruptor
// apagado; un error del piloto nunca autoriza caer al grafo anterior.
export function createWhatsAppPilot({ config, repository, resolvePhone, transport, createRuntime, logger = () => {} }) {
  const admissions = new Map(), runtimes = new Map();
  const lifetime = new AbortController();
  let closed = false;
  async function admit(message) {
    lifetime.signal.throwIfAborted();
    const chatId = message.from;
    const id = await repository.claimMessage(chatId, message.id?._serialized);
    if (!id) return {};
    let completion;
    try {
      let phone = null;
      try { phone = await resolvePhone(chatId); }
      catch { logger({ code: "PHONE_RESOLUTION_FAILED" }); }
      lifetime.signal.throwIfAborted();
      if (!allowsAgentPhone(config, phone)) {
        const notify = await repository.claimMaintenance(chatId);
        completion = notify ? transport.sendText(chatId, config.maintenanceMessage, { origin: "maintenance" }) : Promise.resolve();
      } else {
        if (!runtimes.has(chatId)) {
          const creating = Promise.resolve().then(() => { lifetime.signal.throwIfAborted(); return createRuntime(chatId, { signal: lifetime.signal }); });
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
      closed = true; lifetime.abort(Object.assign(new Error("Piloto cerrado"), { code: "PILOT_CLOSED" })); transport.close();
      await Promise.allSettled([...runtimes.values()].map(async pending => (await pending).shutdown()));
    },
  };
}
