import { createGuardianConfig } from "./config.js";
import { acceptsMessage, createMessageDeduplicator } from "./filters.js";
import { createBurstBuffer, systemClock } from "./burst-buffer.js";
import { prepareSession, sessionHistory } from "./session.js";
import { admitBatch, RATE_LIMIT_NOTICE } from "./rate-limit.js";
import { createTurnAttachments, assertCheckpointState } from "./attachments.js";
import { createMediaPreparer, withSignal } from "./media.js";
import { forceTechnicalHandoff } from "../consultation/terminal.js";
import { modelUsageSince, sumModelUsage } from "../../utils/model-usage.util.js";
import { normalizePurchasePhone } from "../consultation/order-access.js";

export function createGuardianRuntime({ runtime, agent, config = createGuardianConfig(), clock = systemClock,
  audioModel = null, logger = value => console.info(JSON.stringify(value)), processEvents = null }) {
  const media = createMediaPreparer({ config, model: audioModel, getAttachment: id => runtime.transport.getAttachment(id) });
  const deduplicate = createMessageDeduplicator(config.windowMs);
  const controllers = new Set();
  const queues = new Map();
  let closed = false;
  const snapshotUsage = () => sumModelUsage([agent.getModelUsage(), media.getModelUsage()]);
  const save = state => runtime.setState(assertCheckpointState(state));
  const event = value => logger({ event: "guardian", ...value });
  async function execute({ turn, scenario = {}, signal: parentSignal, closedAt = clock.now() }) {
    if (closed) throw Object.assign(new Error("Guardián cerrado"), { code: "GUARDIAN_SHUTDOWN" });
    parentSignal?.throwIfAborted();
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort(parentSignal.reason);
    parentSignal?.addEventListener("abort", abort, { once: true });
    const timeout = Object.assign(new Error("Tiempo del lote agotado"), { code: "GUARDIAN_TIMEOUT" });
    const remaining = closedAt + config.turnTimeoutMs - clock.now();
    const timer = remaining > 0 ? clock.setTimeout(() => controller.abort(timeout), remaining) : null;
    if (remaining <= 0) controller.abort(timeout);
    const signal = controller.signal;
    const registry = createTurnAttachments();
    const before = snapshotUsage();
    const beforeAudio = media.getModelUsage();
    let processed = turn;
    const diagnostics = [];
    const finish = (outcome, extra = {}) => ({ usage: modelUsageSince(before, snapshotUsage()), diagnostics,
      guardian: { outcome, groupedMessages: turn.messages.length, closedAt,
        transcriptionUsage: modelUsageSince(beforeAudio, media.getModelUsage()),
        imageAttachmentIds: (processed.imageInputs ?? []).map(image => image.id), ...extra },
      processedMessages: processed.messages.map(message => ({ text: message.text, type: message.type,
        ...(message.attachmentId ? { attachmentId: message.attachmentId } : {}) })) });
    try {
      signal.throwIfAborted();
      let state = runtime.getState();
      if (state.humanHandoffRequired) {
        const last = turn.messages.at(-1);
        await withSignal(() => runtime.handoffs.updateLastMessage(state.whatsappChatId,
          { lastMessage: last.text, lastMessageType: last.type, lastMessageAt: closedAt }), signal);
        state.lastActivityAt = closedAt;
        await withSignal(() => save(state), signal);
        event({ code: "HANDOFF_SILENCE", turn: turn.turn });
        return finish("handoff");
      }
      const session = prepareSession(state, turn.firstAt ?? closedAt, config, scenario);
      state = session.state;
      const admission = admitBatch(state, closedAt, config);
      state = admission.state;
      state.lastActivityAt = turn.lastAt ?? closedAt;
      await withSignal(() => save(state), signal); // Confirmar persistencia antes de medios/modelo.
      if (!admission.allowed) {
        let noticeIssued = false;
        if (admission.sendNotice) {
          try { await withSignal(() => runtime.transport.sendText(RATE_LIMIT_NOTICE), signal); noticeIssued = true; }
          catch (error) {
            if (parentSignal?.aborted || closed) signal.throwIfAborted();
            // Incluso si el transporte agota el plazo, el bloqueo por límite
            // conserva su episodio y nunca se convierte en una derivación.
            diagnostics.push({ code: signal.aborted ? signal.reason?.code ?? "RATE_NOTICE_SEND_FAILED" : "RATE_NOTICE_SEND_FAILED",
              message: "No se pudo enviar el aviso de límite." });
          }
        }
        event({ code: "TURN_LIMIT", turn: turn.turn, noticeIssued, episodeId: admission.episodeId });
        return finish("limited", { noticeIssued, noticeAttempted: admission.sendNotice });
      }
      if (runtime.resolveIdentity) {
        const identity = await withSignal(() => runtime.resolveIdentity({ signal }), signal);
        const phone = identity.phoneVerified === true ? normalizePurchasePhone(identity.userPhoneNumber) : null;
        state = runtime.getState();
        state.userPhoneNumber = phone;
        state.phoneVerified = phone !== null;
        state.pushname = typeof identity.pushname === "string" ? identity.pushname : null;
        await withSignal(() => save(state), signal);
      }
      processed = await withSignal(() => media.prepare(turn, { signal, registry }), signal);
      for (const issue of processed.mediaIssues) event({ code: issue.code, turn: turn.turn, mediaType: issue.type });
      const response = await withSignal(() => agent.runTurn({ turn: processed, history: sessionHistory(runtime.getState()),
        now: closedAt, signal }), signal);
      signal.throwIfAborted();
      diagnostics.push(...(response?.diagnostics ?? []));
      event({ code: "PROCESSED", turn: turn.turn, groupedMessages: turn.messages.length, newSession: session.newSession });
      return finish("processed", { newSession: session.newSession, mediaBytes: processed.mediaBytes });
    } catch (error) {
      if (parentSignal?.aborted) throw parentSignal.reason;
      if (closed) throw error;
      controller.abort(error);
      diagnostics.push({ code: error.code ?? "GUARDIAN_ERROR", message: "Falla técnica al preparar el turno." });
      await forceTechnicalHandoff(runtime, "Falla técnica: " + (error.code ?? "GUARDIAN_ERROR"), { signal: parentSignal });
      return finish("technical_error");
    } finally {
      clock.clearTimeout(timer);
      controller.abort(Object.assign(new Error("Turno cerrado"), { code: "TURN_CLOSED" }));
      controllers.delete(controller);
      parentSignal?.removeEventListener("abort", abort);
      registry.close();
      if (processed !== turn) processed.imageInputs.length = 0;
    }
  }
  function enqueue(input) {
    const chatId = runtime.getState().whatsappChatId;
    const previous = queues.get(chatId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => { input.onStart?.(); return execute(input); });
    queues.set(chatId, task);
    task.finally(() => { if (queues.get(chatId) === task) queues.delete(chatId); }).catch(() => {});
    return task;
  }
  const bursts = createBurstBuffer({ config, clock, logger, onBatch: batch => {
    return enqueue({ closedAt: batch.closedAt, onStart: () => { batch.status = "processing"; }, turn: {
      turn: batch.messages[0].turn ?? 0, firstAt: batch.firstAt, lastAt: batch.lastAt,
      messages: batch.messages.map(message => ({ text: message.body ?? "", type: message.type || "chat", attachmentId: message.attachment?.id })),
      attachments: batch.messages.flatMap(message => message.attachment ? [message.attachment] : []),
    } }).finally(() => { batch.status = "finished"; });
  } });
  // La recolección no inicia el timeout de procesamiento. El lote cerrado sí.
  const shutdown = () => {
    if (closed) return 0;
    closed = true;
    const discarded = bursts.close();
    for (const controller of controllers) controller.abort(Object.assign(new Error("Apagado del guardián"), { code: "GUARDIAN_SHUTDOWN" }));
    deduplicate.clear();
    processEvents?.off("SIGINT", shutdown);
    processEvents?.off("SIGTERM", shutdown);
    return discarded;
  };
  processEvents?.on("SIGINT", shutdown);
  processEvents?.on("SIGTERM", shutdown);
  return {
    getModelUsage: snapshotUsage,
    metadata: { ...agent.metadata, modelInjected: agent.metadata?.modelInjected === true || media.modelInjected },
    processTurn: enqueue,
    receive(message) {
      if (!acceptsMessage(message)) return Promise.resolve({ guardian: { outcome: "filtered" } });
      if (message.from !== runtime.getState().whatsappChatId) throw new Error("El runtime pertenece a otro chat");
      if (!deduplicate.accept(message.id, clock.now())) return Promise.resolve({ guardian: { outcome: "duplicate" } });
      return bursts.push(message);
    },
    async runDeclaredTurn({ turn, scenario = {}, signal }) {
      signal?.throwIfAborted();
      if (typeof clock.advanceAsync !== "function") throw new Error("Las ráfagas declaradas requieren reloj virtual del runner");
      // El archivo no define intervalos: burst declara un lote. Todos sus
      // mensajes llegan al mismo instante virtual, sin inventar tiempos reales.
      let captured;
      const buffer = createBurstBuffer({ config, clock, onBatch: batch => { captured = batch; } });
      const promises = [];
      for (const message of turn.messages) {
        const envelope = { from: runtime.getState().whatsappChatId, body: message.text, hasMedia: message.type !== "text" && message.type !== "chat",
          type: message.type === "text" ? "chat" : message.type };
        if (acceptsMessage(envelope)) promises.push(buffer.push(envelope));
      }
      if (!promises.length) { buffer.close(); return { usage: modelUsageSince(snapshotUsage(), snapshotUsage()), guardian: { outcome: "filtered" }, diagnostics: [] }; }
      try {
        await clock.advanceAsync(config.silenceMs);
        await Promise.all(promises);
        signal?.throwIfAborted();
        return await enqueue({ turn: { ...turn, firstAt: captured.firstAt, lastAt: captured.lastAt },
          scenario, signal, closedAt: captured.closedAt });
      } finally { buffer.close(); }
    },
    shutdown,
  };
}
