import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { withTimeout } from "./agent-contract.js";

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

export function parseJudgeResponse(text, payload) {
  let value;
  try { value = JSON.parse(text); }
  catch { throw Object.assign(new Error("El evaluador no devolvió JSON válido"), { code: "INVALID_JUDGE_JSON" }); }
  const object = item => item !== null && typeof item === "object" && !Array.isArray(item);
  if (!object(value) || Object.keys(value).some(key => !["verdict", "explanation", "evidence"].includes(key))
      || !["pass", "fail", "not_observable"].includes(value.verdict)
      || typeof value.explanation !== "string" || !value.explanation.trim() || !Array.isArray(value.evidence)) {
    throw Object.assign(new Error("Respuesta del evaluador fuera del contrato"), { code: "INVALID_JUDGE_RESPONSE" });
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
    throw Object.assign(new Error("El evaluador citó evidencia inválida"), { code: "INVALID_JUDGE_EVIDENCE" });
  }
  return value;
}

export function createStubJudge() {
  return {
    kind: "stub", metadata: { kind: "stub", model: null, temperature: null },
    async evaluate() {
      return { verdict: "pass", explanation: "Respuesta fija del evaluador simulado; no mide calidad.", evidence: [], simulated: true };
    },
  };
}

export async function createLLMJudge({ model = null, timeoutMs = 60000 } = {}) {
  const prompt = await readFile(new URL("./judge-prompt.md", import.meta.url), "utf8");
  if (!model) {
    const { createGeminiModel } = await import("../../src/config/llm.js");
    model = createGeminiModel({ temperature: 0 });
  }
  return {
    kind: "llm",
    metadata: {
      kind: "llm", model: model.model ?? process.env.GEMINI_MODEL ?? "createGeminiModel",
      temperature: 0, promptHash: createHash("sha256").update(prompt).digest("hex"),
    },
    async evaluate(input) {
      const payload = buildJudgePayload(input);
      const response = await withTimeout(signal => model.invoke([
        ["system", prompt], ["human", JSON.stringify(payload)],
      ], { signal }), timeoutMs, "JUDGE_TIMEOUT");
      const text = typeof response.content === "string" ? response.content
        : Array.isArray(response.content) ? response.content.filter(block => block?.type === "text").map(block => block.text).join("") : "";
      return { ...parseJudgeResponse(text, payload), usage: response.usage_metadata ?? null };
    },
  };
}
