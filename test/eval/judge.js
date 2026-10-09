import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { withTimeout } from "./agent-contract.js";
import { createModelUsageTracker, emptyModelUsage } from "../../src/utils/model-usage.util.js";

// Lista permitida: jamás se serializa el adaptador, el checkpoint ni mensajes system.
export function buildJudgePayload({ criterion, conversation, tools, referenceData, before, after, identity, turnSnapshots = [] }) {
  return {
    criterion: { kind: criterion.kind, text: criterion.text },
    conversation: conversation.filter(item => ["user", "assistant"].includes(item.role)).map(item => ({
      role: item.role, turn: item.turn, content: item.content,
      ...(item.attachment ? { attachment: {
        type: item.attachment.type, mode: item.attachment.mode,
        description: item.attachment.description ?? null, filename: item.attachment.filename ?? null,
      } } : {}),
      ...(item.eventId ? { eventId: item.eventId } : {}),
    })),
    tools: tools.filter(item => item.phase === "case").map(item => ({
      id: item.id, turn: item.turn, name: item.name, args: structuredClone(item.args),
      status: item.status, result: structuredClone(item.result ?? null), error: structuredClone(item.error ?? null),
      handlerInvoked: item.handlerInvoked ?? null,
    })),
    referenceData: structuredClone({
      catalog: { categories: referenceData.catalog.categories, products: referenceData.catalog.products },
      policies: referenceData.policies, orders: referenceData.orders,
    }),
    snapshots: {
      before: structuredClone({ cart: before.cart, orders: before.orders }),
      after: structuredClone({ cart: after.cart, orders: after.orders }),
      turns: turnSnapshots.map(({ turn, snapshot }) => ({
        turn, cart: structuredClone(snapshot.cart), orders: structuredClone(snapshot.orders),
      })),
    },
    identity: { phoneVerified: identity.phoneVerified, userPhoneNumber: identity.userPhoneNumber },
  };
}

function invalidJudgeResponse(code, message, text) {
  return Object.assign(new Error(message), { code, rawExcerpt: text.slice(0, 300) });
}

function firstBalancedObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  return null;
}

export function parseJudgeResponse(text, payload) {
  text = typeof text === "string" ? text : "";
  let value;
  try { value = JSON.parse(text); }
  catch {
    const extracted = firstBalancedObject(text);
    try {
      if (extracted === null) throw new Error("No hay objeto JSON balanceado");
      value = JSON.parse(extracted);
    } catch {
      throw invalidJudgeResponse("INVALID_JUDGE_JSON", "El evaluador no devolvió JSON válido", text);
    }
  }
  const object = item => item !== null && typeof item === "object" && !Array.isArray(item);
  if (!object(value) || Object.keys(value).some(key => !["verdict", "explanation", "evidence"].includes(key))
      || !["pass", "fail", "not_observable"].includes(value.verdict)
      || typeof value.explanation !== "string" || !value.explanation.trim() || !Array.isArray(value.evidence)) {
    throw invalidJudgeResponse("INVALID_JUDGE_RESPONSE", "Respuesta del evaluador fuera del contrato", text);
  }
  const turns = new Set(payload.conversation.map(item => item.turn));
  const events = new Map([
    ...payload.tools.map(item => [item.id, item.turn]),
    ...payload.conversation.filter(item => item.eventId).map(item => [item.eventId, item.turn]),
  ]);
  if (value.evidence.some(item => !object(item)
      || Object.keys(item).some(key => !["turn", "eventId", "quote"].includes(key))
      || !Number.isInteger(item.turn) || !turns.has(item.turn)
      || !(item.eventId === null || (typeof item.eventId === "string" && events.get(item.eventId) === item.turn))
      || typeof item.quote !== "string")) {
    throw invalidJudgeResponse("INVALID_JUDGE_EVIDENCE", "El evaluador citó evidencia inválida", text);
  }
  return value;
}

export function createStubJudge() {
  return {
    kind: "stub", metadata: { kind: "stub", model: null, temperature: null },
    getModelUsage: emptyModelUsage,
    async evaluate() {
      return { verdict: "not_evaluated", explanation: "Criterio no evaluado: el evaluador simulado solo comprueba la tubería.", evidence: [], simulated: true };
    },
  };
}

export async function createLLMJudge({ model = null, timeoutMs = 60000 } = {}) {
  const modelInjected = model !== null;
  const tracker = createModelUsageTracker();
  const prompt = await readFile(new URL("./judge-prompt.md", import.meta.url), "utf8");
  if (!model) {
    const { createGeminiModel } = await import("../../src/config/llm.js");
    model = createGeminiModel({ temperature: 0 });
  }
  return {
    kind: "llm",
    getModelUsage: () => tracker.snapshot(),
    metadata: {
      kind: "llm", model: model.model ?? process.env.GEMINI_MODEL ?? "createGeminiModel",
      temperature: 0, modelInjected, promptHash: createHash("sha256").update(prompt).digest("hex"),
    },
    async evaluate(input) {
      const payload = buildJudgePayload(input);
      const messages = [["system", prompt], ["human", JSON.stringify(payload)]];
      const invoke = messages => tracker.invoke(() => withTimeout(signal => model.invoke(messages,
        { signal }), timeoutMs, "JUDGE_TIMEOUT"));
      const content = response => typeof response?.content === "string" ? response.content
        : Array.isArray(response?.content) ? response.content.filter(block => block?.type === "text" && typeof block.text === "string")
          .map(block => block.text).join("") : "";
      const response = await invoke(messages);
      try {
        return { ...parseJudgeResponse(content(response), payload), usage: response.usage_metadata ?? null };
      } catch (error) {
        if (!["INVALID_JUDGE_JSON", "INVALID_JUDGE_RESPONSE", "INVALID_JUDGE_EVIDENCE"].includes(error.code)) throw error;
        let retry;
        try {
          retry = await invoke([...messages, response,
            ["human", "Devolvé solo un objeto JSON válido con verdict, explanation y evidence según el contrato, sin Markdown ni texto adicional."]]);
        } catch (retryError) {
          // Si falla el proveedor, conservar el contenido inválido ya recibido.
          retryError.rawExcerpt = error.rawExcerpt;
          throw retryError;
        }
        return { ...parseJudgeResponse(content(retry), payload), usage: retry.usage_metadata ?? null };
      }
    },
  };
}
