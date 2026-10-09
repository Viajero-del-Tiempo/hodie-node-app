import test from "node:test";
import assert from "node:assert/strict";
import { buildJudgePayload, parseJudgeResponse, createLLMJudge, createStubJudge } from "./eval/judge.js";

const secret = "PRIVATE_AGENT_PROMPT_SENTINEL";
test("juez simulado deja must, must_not y ofertas sin evaluar; no inventa aprobación ni evidencia", async () => {
  const judge = createStubJudge();
  for (const kind of ["must", "must_not", "handoff_offer"]) {
    const judgment = await judge.evaluate({ criterion: { kind, text: "Criterio de prueba." } });
    assert.equal(judgment.verdict, "not_evaluated");
    assert.equal(judgment.simulated, true);
    assert.deepEqual(judgment.evidence, []);
    assert.match(judgment.explanation, /no evaluado/);
  }
});
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
  assert.throws(() => parseJudgeResponse(JSON.stringify({ ...valid, verdict: "not_evaluated" }), payload), { code: "INVALID_JUDGE_RESPONSE" });
  assert.throws(() => parseJudgeResponse(JSON.stringify({ ...valid, evidence: [{ turn: 99, eventId: null, quote: "Inventado" }] }), payload), { code: "INVALID_JUDGE_EVIDENCE" });
  assert.throws(() => parseJudgeResponse(JSON.stringify({ ...valid, evidence: [{ turn: 1, eventId: "missing", quote: "Inventado" }] }), payload), { code: "INVALID_JUDGE_EVIDENCE" });
  payload.tools.push({ id: "tool-2", turn: 2 });
  assert.throws(() => parseJudgeResponse(JSON.stringify({ ...valid, evidence: [{ turn: 1, eventId: "tool-2", quote: "Otro turno" }] }), payload), { code: "INVALID_JUDGE_EVIDENCE" });
});
test("parsea JSON en un bloque de código con objetos anidados y llaves dentro de cadenas", () => {
  const payload = buildJudgePayload(input());
  const valid = { verdict: "fail", explanation: 'Texto con "comillas", una llave } y una barra \\.',
    evidence: [{ turn: 1, eventId: "send-1", quote: "Respuesta {citada}" }] };
  assert.deepEqual(parseJudgeResponse("```json\n" + JSON.stringify(valid) + "\n```", payload), valid);
});
test("extrae el primer objeto JSON balanceado con texto alrededor, sin elegir un veredicto posterior", () => {
  const payload = buildJudgePayload(input());
  const first = { verdict: "fail", explanation: "El criterio no se cumplió.", evidence: [] };
  const second = { ...first, verdict: "pass" };
  assert.deepEqual(parseJudgeResponse("Resultado:\n" + JSON.stringify(first)
    + "\nFin de la respuesta. " + JSON.stringify(second), payload), first);
  assert.throws(() => parseJudgeResponse("Resultado: {} " + JSON.stringify(second), payload), { code: "INVALID_JUDGE_RESPONSE" });
  assert.throws(() => parseJudgeResponse("Resultado: {sin JSON} " + JSON.stringify(second), payload), { code: "INVALID_JUDGE_JSON" });
  assert.throws(() => parseJudgeResponse(JSON.stringify([second]), payload), { code: "INVALID_JUDGE_RESPONSE" });
});
test("tolerar envoltorios no permite esquemas ni evidencia inválidos", () => {
  const payload = buildJudgePayload(input());
  const valid = { verdict: "pass", explanation: "Respuesta.", evidence: [] };
  assert.throws(() => parseJudgeResponse("```json\n" + JSON.stringify({ ...valid, verdict: true }) + "\n```", payload),
    { code: "INVALID_JUDGE_RESPONSE" });
  assert.throws(() => parseJudgeResponse("Respuesta: " + JSON.stringify({ ...valid,
    evidence: [{ turn: 99, eventId: null, quote: "Evidencia inventada" }] }) + " Fin.", payload),
    { code: "INVALID_JUDGE_EVIDENCE" });
});
test("una respuesta inválida se reintenta una vez y devuelve el veredicto real del reintento", async () => {
  const invalid = ["No devolví JSON", JSON.stringify({ verdict: true, explanation: "Respuesta", evidence: [] }),
    JSON.stringify({ verdict: "pass", explanation: "Respuesta", evidence: [{ turn: 99, eventId: null, quote: "Inválida" }] })];
  for (const content of invalid) {
    const calls = [];
    const valid = { verdict: "fail", explanation: "El criterio no se cumplió.", evidence: [] };
    const first = { content, usage_metadata: { input_tokens: 8, output_tokens: 1, total_tokens: 9 } };
    const second = { content: JSON.stringify(valid), usage_metadata: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } };
    const judge = await createLLMJudge({ model: { async invoke(messages, options) {
      calls.push([...messages]);
      assert.ok(options.signal);
      assert.equal(JSON.stringify(messages).includes(secret), false);
      assert.ok(calls.length <= 2, "No debe haber un segundo reintento");
      return calls.length === 1 ? first : second;
    } } });
    const judgment = await judge.evaluate(input());
    assert.deepEqual(judgment, { ...valid, usage: second.usage_metadata });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].length, 2);
    assert.equal(calls[1].length, 4);
    assert.deepEqual(calls[1].slice(0, 2), calls[0]);
    assert.equal(calls[1][2], first);
    assert.equal(calls[1][3][0], "human");
    assert.match(calls[1][3][1], /solo un objeto JSON/);
    assert.ok(calls[1][3][1].length < 200);
    assert.equal(judge.getModelUsage().calls, 2);
    assert.deepEqual(judge.getModelUsage().reportedTokens, { input: 18, output: 5, total: 23 });
  }
});
test("un reintento inválido sigue siendo error y conserva el extracto del último contenido truncado", async () => {
  const first = "Primera respuesta inválida";
  const last = "Última respuesta inválida: " + "x".repeat(400);
  let calls = 0;
  const judge = await createLLMJudge({ model: { async invoke(messages) {
    assert.equal(JSON.stringify(messages).includes(secret), false);
    assert.ok(++calls <= 2, "Solo se permite un reintento");
    return { content: calls === 1 ? first : last,
      usage_metadata: { input_tokens: 8, output_tokens: 1, total_tokens: 9 } };
  } } });
  await assert.rejects(judge.evaluate(input()), error => {
    assert.equal(error.code, "INVALID_JUDGE_JSON");
    assert.equal(error.rawExcerpt.length, 300);
    assert.equal(error.rawExcerpt, last.slice(0, 300));
    assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  });
  assert.equal(calls, 2);
  assert.equal(judge.getModelUsage().calls, 2);
  assert.deepEqual(judge.getModelUsage().reportedTokens, { input: 16, output: 2, total: 18 });
});
test("un reintento fuera del esquema no se transforma en un veredicto", async () => {
  const content = JSON.stringify({ verdict: "pass", explanation: "Respuesta", evidence: [], unexpected: "Dato" });
  let calls = 0;
  const judge = await createLLMJudge({ model: { async invoke() {
    assert.ok(++calls <= 2, "Solo se permite un reintento");
    return { content };
  } } });
  await assert.rejects(judge.evaluate(input()), { code: "INVALID_JUDGE_RESPONSE", rawExcerpt: content });
  assert.equal(calls, 2);
});
test("si el proveedor falla al reintentar, conserva el extracto de la respuesta inválida recibida", async () => {
  const content = "Contenido inválido: " + "x".repeat(400);
  let calls = 0;
  const judge = await createLLMJudge({ model: { async invoke() {
    if (++calls === 1) return { content, usage_metadata: { input_tokens: 8, output_tokens: 1, total_tokens: 9 } };
    throw new Error("Proveedor caído en el reintento");
  } } });
  await assert.rejects(judge.evaluate(input()), error => {
    assert.equal(error.message, "Proveedor caído en el reintento");
    assert.equal(error.rawExcerpt, content.slice(0, 300));
    return true;
  });
  assert.equal(calls, 2);
  assert.equal(judge.getModelUsage().calls, 2);
  assert.equal(judge.getModelUsage().failedCalls, 1);
  assert.equal(judge.getModelUsage().callsWithoutUsage, 1);
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
  let brokenCalls = 0;
  const broken = await createLLMJudge({ model: { async invoke() { brokenCalls++; throw new Error("Proveedor caído"); } } });
  await assert.rejects(broken.evaluate(input()), /Proveedor caído/);
  assert.equal(brokenCalls, 1);
  let slowCalls = 0;
  const slow = await createLLMJudge({ timeoutMs: 5, model: {
    invoke(_messages, { signal }) {
      slowCalls++;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  } });
  await assert.rejects(slow.evaluate(input()), { code: "JUDGE_TIMEOUT" });
  assert.equal(slowCalls, 1);
});
