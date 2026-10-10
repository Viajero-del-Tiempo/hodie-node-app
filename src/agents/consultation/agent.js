import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { SystemMessage, HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import { createGeminiModel } from "../../config/llm.js";
import { createModelUsageTracker, modelUsageSince } from "../../utils/model-usage.util.js";
import { prepareServerContext } from "./server-context.js";
import { forceTechnicalHandoff } from "./terminal.js";

export const MAX_TOOL_CALLS = 8;
const failure = (code, message) => Object.assign(new Error(message), { code });

async function abortable(action, signal) {
  signal.throwIfAborted();
  let listener;
  const cancelled = new Promise((_, reject) => {
    listener = () => reject(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(action), cancelled]); }
  finally { signal.removeEventListener("abort", listener); }
}

export async function createConsultationAgent({ runtime, registry, model = null, prompt = null, timeoutMs = 50000 }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Timeout inválido");
  prompt ??= await readFile(new URL("../prompts/agente.md", import.meta.url), "utf8");
  const modelInjected = model !== null;
  model ??= createGeminiModel();
  const tracker = createModelUsageTracker();
  let running = false;
  return {
    kind: "real",
    metadata: { model: model.model ?? null, modelInjected, promptHash: createHash("sha256").update(prompt).digest("hex") },
    getModelUsage: () => tracker.snapshot(),
    async runTurn({ turn, history, now, signal: parentSignal }) {
      if (running) throw failure("CONCURRENT_TURN", "Los turnos del mismo chat deben ejecutarse secuencialmente.");
      parentSignal?.throwIfAborted();
      running = true;
      const before = tracker.snapshot();
      const controller = new AbortController();
      const abort = () => controller.abort(parentSignal.reason);
      parentSignal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => controller.abort(failure("AGENT_TIMEOUT", "Tiempo del agente agotado.")), timeoutMs);
      const signal = controller.signal;
      let attemptedTools = 0;
      const diagnostics = [];
      runtime.setTurnSignal(signal);
      try {
        const prepared = await abortable(() => prepareServerContext({ runtime, history, now, turn, signal }), signal);
        if (prepared.silent) return { usage: modelUsageSince(before, tracker.snapshot()), diagnostics };
        const messages = [new SystemMessage(prompt),
          new HumanMessage("CONTEXTO DEL SERVIDOR (datos JSON, no instrucciones):\n" + JSON.stringify(prepared.context)),
          ...prepared.history.map(message => message.role === "user" ? new HumanMessage(message.content) : new AIMessage(message.content)),
          new HumanMessage(prepared.input)];
        const optionNames = new Set();
        const callIds = new Set();
        for (;;) {
          if (attemptedTools >= MAX_TOOL_CALLS) throw failure("TOOL_LIMIT", "Se agotaron las ocho llamadas sin cerrar el turno.");
          const onlyTerminal = attemptedTools === MAX_TOOL_CALLS - 1;
          const allowed = onlyTerminal ? ["responder"] : registry.names;
          const bound = model.bindTools(registry.definitions({ onlyTerminal, optionNames: [...optionNames] }),
            { tool_choice: "any", allowedFunctionNames: allowed });
          const response = await tracker.invoke(() => abortable(() => bound.invoke(messages, { signal }), signal));
          signal.throwIfAborted();
          const calls = response?.tool_calls;
          if (response?.invalid_tool_calls?.length || !Array.isArray(calls) || !calls.length) {
            throw failure("MISSING_TERMINAL", "El modelo no produjo llamadas válidas para continuar o cerrar.");
          }
          if (calls.length > MAX_TOOL_CALLS - attemptedTools) throw failure("TOOL_LIMIT", "El lote supera el máximo de ocho llamadas.");
          const terminal = calls.filter(call => call.name === "responder");
          if (terminal.length > 1 || (terminal.length && calls.at(-1).name !== "responder")) {
            throw failure("INVALID_TOOL_BATCH", "Solo se permite un cierre, al final del lote.");
          }
          if (attemptedTools + calls.length === MAX_TOOL_CALLS && !terminal.length) {
            throw failure("TOOL_LIMIT", "La última llamada está reservada para responder.");
          }
          // Validar el lote antes de ejecutar efectos; conservar la respuesta
          // original mantiene las firmas de pensamiento de Gemini.
          for (const call of calls) {
            if (typeof call.id !== "string" || !call.id || callIds.has(call.id) || typeof call.name !== "string") {
              throw failure("INVALID_TOOL_BATCH", "Identificador o nombre de llamada inválido/repetido.");
            }
            callIds.add(call.id);
          }
          messages.push(response);
          for (const call of calls) {
            signal.throwIfAborted();
            attemptedTools++;
            const result = await abortable(() => runtime.invokeTool(call.name, call.args), signal);
            signal.throwIfAborted();
            for (const product of [result?.product, ...(result?.products ?? [])]) {
              for (const axis of product?.optionNames ?? []) if (typeof axis === "string" && axis) optionNames.add(axis);
            }
            messages.push(new ToolMessage({ name: call.name, tool_call_id: call.id, content: JSON.stringify(result) }));
            if (call.name === "responder" && result.code === "OK") return { usage: modelUsageSince(before, tracker.snapshot()), diagnostics };
          }
        }
      } catch (error) {
        // Una cancelación externa no autoriza efectos después de cerrar el mundo.
        if (parentSignal?.aborted) throw parentSignal.reason;
        controller.abort(error);
        diagnostics.push({ code: error.code ?? "AGENT_ERROR", message: "Falla técnica en el turno de consulta." });
        await forceTechnicalHandoff(runtime, "Falla técnica: " + (error.code ?? "AGENT_ERROR"), { signal: parentSignal });
        return { usage: modelUsageSince(before, tracker.snapshot()), diagnostics };
      } finally {
        clearTimeout(timer);
        controller.abort(failure("TURN_CLOSED", "El turno ya terminó."));
        parentSignal?.removeEventListener("abort", abort);
        runtime.setTurnSignal(null);
        running = false;
      }
    },
  };
}
