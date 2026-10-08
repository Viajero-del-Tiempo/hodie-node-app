import test from "node:test";
import assert from "node:assert/strict";
import { buildJudgePayload, parseJudgeResponse, createLLMJudge } from "./eval/judge.js";

const secret = "PRIVATE_AGENT_PROMPT_SENTINEL";
function input() {
  const snapshot = { cart: { lines: [] }, orders: [], privatePrompt: secret };
  return {
    criterion: { kind: "must_not", text: "No inventa un dato.", privatePrompt: secret },
    conversation: [
      { role: "system", turn: 0, content: secret },
      { role: "user", turn: 1, content: "Hola", internal: secret },
      { role: "assistant", turn: 1, content: "Respuesta", eventId: "send-1" },
    ],
    tools: [{ id: "tool-1", phase: "case", turn: 1, name: "responder", args: {}, status: "completed", result: { code: "OK" }, internal: secret }],
    referenceData: { catalog: { products: [], categories: [], privatePrompt: secret }, policies: [], orders: [], privatePrompt: secret },
    before: snapshot, after: snapshot,
    identity: { phoneVerified: false, userPhoneNumber: null, privatePrompt: secret },
    agentPrompt: secret, checkpoint: { systemPrompt: secret },
  };
}
test("payload permite solo evidencia pública y excluye prompt, sistema y checkpoint", () => {
  const payload = buildJudgePayload(input());
  assert.equal(JSON.stringify(payload).includes(secret), false);
  assert.equal(payload.conversation.length, 2);
  assert.equal(payload.criterion.kind, "must_not");
  assert.equal(payload.snapshots.before.privatePrompt, undefined);
});
test("veredictos tienen polaridad clara y rechazan JSON/esquema/evidencia incorrectos", () => {
  const payload = buildJudgePayload(input());
  const valid = { verdict: "pass", explanation: "No ocurrió lo prohibido.", evidence: [] };
  assert.equal(parseJudgeResponse(JSON.stringify(valid), payload).verdict, "pass");
  assert.throws(() => parseJudgeResponse("no es JSON", payload), { code: "INVALID_JUDGE_JSON" });
  assert.throws(() => parseJudgeResponse(JSON.stringify({ ...valid, verdict: true }), payload), { code: "INVALID_JUDGE_RESPONSE" });
  assert.throws(() => parseJudgeResponse(JSON.stringify({ ...valid, evidence: [{ turn: 99, eventId: null, quote: "Inventado" }] }), payload), { code: "INVALID_JUDGE_EVIDENCE" });
  assert.throws(() => parseJudgeResponse(JSON.stringify({ ...valid, evidence: [{ turn: 1, eventId: "missing", quote: "Inventado" }] }), payload), { code: "INVALID_JUDGE_EVIDENCE" });
  payload.tools.push({ id: "tool-2", turn: 2 });
  assert.throws(() => parseJudgeResponse(JSON.stringify({ ...valid, evidence: [{ turn: 1, eventId: "tool-2", quote: "Otro turno" }] }), payload), { code: "INVALID_JUDGE_EVIDENCE" });
});
test("cada criterio tiene una invocación independiente con temperatura documentada y sin prompt privado", async () => {
  const calls = [];
  const model = { model: "test-judge", async invoke(messages, options) {
    calls.push(messages);
    assert.ok(options.signal);
    assert.equal(JSON.stringify(messages).includes(secret), false);
    return { content: JSON.stringify({ verdict: "pass", explanation: "Evidencia suficiente.", evidence: [] }), usage_metadata: { input_tokens: 1, output_tokens: 1 } };
  } };
  const judge = await createLLMJudge({ model });
  await judge.evaluate(input());
  await judge.evaluate({ ...input(), criterion: { kind: "must", text: "Responde." } });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(messages => messages.length === 2));
  assert.equal(judge.metadata.temperature, 0);
  assert.match(judge.metadata.promptHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(calls[1][1][1]).criterion.kind, "must");
});
test("errores y timeout del evaluador no se convierten en aprobaciones", async () => {
  const broken = await createLLMJudge({ model: { async invoke() { throw new Error("Proveedor caído"); } } });
  await assert.rejects(broken.evaluate(input()), /Proveedor caído/);
  const slow = await createLLMJudge({ timeoutMs: 5, model: {
    invoke(_messages, { signal }) { return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); },
  } });
  await assert.rejects(slow.evaluate(input()), { code: "JUDGE_TIMEOUT" });
});
