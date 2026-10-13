import { createGuardianConfig } from "./config.js";
import { acceptsMessage, createMessageDeduplicator } from "./filters.js";
import { createBurstBuffer, systemClock } from "./burst-buffer.js";
import { prepareSession, sessionHistory } from "./session.js";
import { admitBatch, RATE_LIMIT_NOTICE } from "./rate-limit.js";
import { createTurnAttachments, assertCheckpointState } from "./attachments.js";
import { MODEL_CLOCK } from "../consultation/model-invoker.js";
import { createMediaPreparer, withSignal } from "./media.js";
import { handleTechnicalFailure, resetTechnicalFailures } from "../consultation/technical-failure.js";
import { modelUsageSince, sumModelUsage, safeErrorDetails } from "../../utils/model-usage.util.js";
import { normalizePurchasePhone } from "../consultation/order-access.js";
import { randomUUID } from "node:crypto";

export function createGuardianRuntime({ runtime, agent, config = createGuardianConfig(), clock = systemClock,
  audioModel = null, logger = value => console.info(JSON.stringify(value)), processEvents = null, deadlineClock = MODEL_CLOCK }) {
  const media = createMediaPreparer({ config, model: audioModel, getAttachment: id => runtime.transport.getAttachment(id),
    setExecutionPhase: runtime.setExecutionPhase });
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
    const deadlineMs = deadlineClock.now() + Math.max(0, remaining);
    const timer = remaining > 0 ? clock.setTimeout(() => controller.abort(timeout), remaining) : null;
    // El reloj de escenarios puede ser virtual; el plazo real incluye medios.
    const deadlineTimer = remaining > 0 && deadlineClock !== clock
      ? deadlineClock.setTimeout(() => controller.abort(timeout), remaining) : null;
    if (remaining <= 0) controller.abort(timeout);
    const signal = controller.signal;
    const registry = createTurnAttachments();
    const before = snapshotUsage();
    const beforeAudio = media.getModelUsage();
    const batchId = turn.batchId ?? randomUUID();
    let processed = turn;
    const diagnostics = [];
    const finish = (outcome, extra = {}) => ({ usage: modelUsageSince(before, snapshotUsage()), diagnostics,
      guardian: { outcome, groupedMessages: turn.messages.length, closedAt,
        transcriptionUsage: modelUsageSince(beforeAudio, media.getModelUsage()),
        imageAttachmentIds: (processed.imageInputs ?? []).map(image => image.id), ...extra },
      processedMessages: processed.messages.map(message => ({ text: message.text, type: message.type,
        ...(message.attachmentId ? { attachmentId: message.attachmentId } : {}) })) });
    try {
      runtime.setExecutionPhase?.("guardian_admission");
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
      if (admission.allowed && runtime.setTurnContext) state.turnSequence = (state.turnSequence ?? 0) + 1;
      await withSignal(() => save(state), signal); // Confirmar persistencia antes de medios/modelo.
      if (!admission.allowed) {
        let noticeIssued = false;
        if (admission.sendNotice) {
          runtime.setExecutionPhase?.("rate_limit_notice");
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
        runtime.setExecutionPhase?.("identity");
        const identity = await withSignal(() => runtime.resolveIdentity({ signal }), signal);
        const phone = identity.phoneVerified === true ? normalizePurchasePhone(identity.userPhoneNumber) : null;
        state = runtime.getState();
        state.userPhoneNumber = phone;
        state.phoneVerified = phone !== null;
        state.pushname = typeof identity.pushname === "string" ? identity.pushname : null;
        await withSignal(() => save(state), signal);
      }
      runtime.setExecutionPhase?.("media_preparation");
      processed = await withSignal(() => media.prepare(turn, { signal, registry }), signal);
      runtime.setTurnContext?.({ id: batchId, sequence: runtime.getState().turnSequence,
        messages: processed.messages.map(message => ({ text: message.text, type: message.type })), closedAt,
        deadlineMs, deadlineEpoch: closedAt + config.turnTimeoutMs });
      runtime.setTurnAttachments?.(registry);
      for (const issue of processed.mediaIssues) event({ code: issue.code, turn: turn.turn, mediaType: issue.type });
      runtime.setExecutionPhase?.("agent_adapter");
      const response = await withSignal(() => agent.runTurn({ turn: processed, history: sessionHistory(runtime.getState()),
        now: closedAt, signal }), signal);
      signal.throwIfAborted();
      diagnostics.push(...(response?.diagnostics ?? []));
      if (!response?.technicalFailure || response.orderRecovered) await withSignal(() => resetTechnicalFailures(runtime, { signal }), signal);
      event({ code: "PROCESSED", turn: turn.turn, groupedMessages: turn.messages.length, newSession: session.newSession });
      return finish(response?.technicalFailure ? "technical_error" : "processed", {
        newSession: session.newSession, mediaBytes: processed.mediaBytes,
        ...(response?.orderCommitted ? { orderCommitted: true, orderRecovered: response.orderRecovered === true } : {}) });
    } catch (error) {
      if (parentSignal?.aborted) throw parentSignal.reason;
      if (closed) throw error;
      controller.abort(error);
      diagnostics.push({ code: error.code ?? "GUARDIAN_ERROR", message: "Falla técnica al preparar el turno.", technicalFailure: true,
        ...safeErrorDetails(error),
        ...(runtime.getExecutionPhase ? { interruptedPhase: runtime.getExecutionPhase() } : {}) });
      // El commit es irreversible y su trabajo durable recupera el pago/PDF.
      // No reemplazar ese mensaje por el aviso técnico ni escalar esta compra.
      if (runtime.getCommittedReceipt && await runtime.getCommittedReceipt()) return finish("technical_error", { orderCommitted: true });
      await handleTechnicalFailure(runtime, error.code ?? "GUARDIAN_ERROR", { signal: parentSignal, turnId: batchId,
        lastMessage: turn.messages.at(-1)?.text, now: clock.now() });
      return finish("technical_error");
    } finally {
      clock.clearTimeout(timer);
      deadlineClock.clearTimeout(deadlineTimer);
      controller.abort(Object.assign(new Error("Turno cerrado"), { code: "TURN_CLOSED" }));
      controllers.delete(controller);
      parentSignal?.removeEventListener("abort", abort);
      registry.close();
      runtime.setTurnAttachments?.(null);
      runtime.setTurnContext?.(null);
      if (processed !== turn) processed.imageInputs.length = 0;
    }
  }
  function enqueue(input) {
    const chatId = runtime.getState().whatsappChatId;
    const previous = queues.get(chatId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => {
      if (closed) throw Object.assign(new Error("Guardián cerrado"), { code: "GUARDIAN_SHUTDOWN" });
      input.signal?.throwIfAborted();
      input.onStart?.();
      return execute(input);
    });
    queues.set(chatId, task);
    task.finally(() => { if (queues.get(chatId) === task) queues.delete(chatId); }).catch(() => {});
    return task;
  }
  const bursts = createBurstBuffer({ config, clock, logger, onBatch: batch => {
    return enqueue({ closedAt: batch.closedAt, onStart: () => { batch.status = "processing"; }, turn: {
      turn: batch.messages[0].turn ?? 0, batchId: batch.id, firstAt: batch.firstAt, lastAt: batch.lastAt,
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
    async runDeclaredTurn({ turn, scenario = {}, signal: parentSignal }) {
      if (closed) throw Object.assign(new Error("Guardián cerrado"), { code: "GUARDIAN_SHUTDOWN" });
      parentSignal?.throwIfAborted();
      // Registrar la cancelación antes de la primera espera, también durante
      // la ráfaga declarada y mientras el lote espera su lugar en la cola.
      const controller = new AbortController();
      const signal = controller.signal;
      const abort = () => controller.abort(parentSignal.reason);
      parentSignal?.addEventListener("abort", abort, { once: true });
      controllers.add(controller);
      let buffer;
      try {
        runtime.setExecutionPhase?.("burst_buffer");
        if (typeof clock.advanceAsync !== "function") throw new Error("Las ráfagas declaradas requieren reloj virtual del runner");
        // El archivo no define intervalos: burst declara un lote. Todos sus
        // mensajes llegan al mismo instante virtual, sin inventar tiempos reales.
        let captured;
        buffer = createBurstBuffer({ config, clock, onBatch: batch => { captured = batch; } });
        const promises = [];
        for (const message of turn.messages) {
          const envelope = { from: runtime.getState().whatsappChatId, body: message.text, hasMedia: message.type !== "text" && message.type !== "chat",
            type: message.type === "text" ? "chat" : message.type };
          if (acceptsMessage(envelope)) promises.push(buffer.push(envelope));
        }
        if (!promises.length) return { usage: modelUsageSince(snapshotUsage(), snapshotUsage()), guardian: { outcome: "filtered" }, diagnostics: [] };
        await withSignal(() => clock.advanceAsync(config.silenceMs), signal);
        await withSignal(() => Promise.all(promises), signal);
        signal.throwIfAborted();
        return await enqueue({ turn: { ...turn, batchId: captured.id, firstAt: captured.firstAt, lastAt: captured.lastAt },
          scenario, signal, closedAt: captured.closedAt });
      } finally {
        buffer?.close();
        controller.abort(Object.assign(new Error("Turno cerrado"), { code: "TURN_CLOSED" }));
        controllers.delete(controller);
        parentSignal?.removeEventListener("abort", abort);
      }
    },
    shutdown,
  };
}
