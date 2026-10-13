import test from "node:test";
import assert from "node:assert/strict";
import { createModelInvoker, resolveModelCallTimeout } from "../src/agents/consultation/model-invoker.js";
import { createModelUsageTracker, classifyModelError, safeErrorDetails } from "../src/utils/model-usage.util.js";
import { createVirtualClock, flushMicrotasks } from "./helpers/virtual-clock.js";
import { consultationFixture, scriptedModel, reply } from "./helpers/consultation-fixtures.js";
import { createGeminiModel } from "../src/config/llm.js";
import { GoogleGenerativeAIError, GoogleGenerativeAIFetchError, GoogleGenerativeAIRequestInputError } from "@google/generative-ai";
import { TECHNICAL_FAILURE_NOTICE, TECHNICAL_HANDOFF_MESSAGE } from "../src/agents/consultation/technical-failure.js";

test("timeout de llamada valida entorno/override; default 20 segundos sin cambiar pensamiento ni timeout del turno", () => {
  assert.equal(resolveModelCallTimeout({}), 20000);
  assert.equal(resolveModelCallTimeout({ AGENT_MODEL_CALL_TIMEOUT_MS: "15000" }), 15000);
  assert.equal(resolveModelCallTimeout({ AGENT_MODEL_CALL_TIMEOUT_MS: "bad" }, 20000), 20000);
  for (const value of [0, 999, 60001, -1, "", "1e3", "20000.5", "bad", true, null])
    assert.throws(() => resolveModelCallTimeout({}, value), { code: "INVALID_MODEL_CALL_TIMEOUT" });
});
test("fábrica Gemini conserva retry default; solo el opt-in explícito del agente lo desactiva, sin invocar modelo", () => {
  const previous = process.env.GEMINI_API_KEY;
  try {
    process.env.GEMINI_API_KEY = "test-no-network-key";
    const normal = createGeminiModel(), agent = createGeminiModel({ thinkingBudget: 512, maxRetries: 0 });
    assert.equal(normal.caller.maxRetries, 6); assert.equal(agent.caller.maxRetries, 0);
  } finally { if (previous === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previous; }
});
test("respuesta exitosa limpia su plazo y conserva la señal hasta la cancelación del turno", async () => {
  const clock = createVirtualClock(0), controller = new AbortController();
  const tracker = createModelUsageTracker({ now: clock.now });
  const invoker = createModelInvoker({ tracker, clock, getRemainingMs: () => 60000 - clock.now() });
  let providerSignal;
  try {
    const response = await invoker.invoke(signal => { providerSignal = signal; return { content: "Respuesta" }; }, { signal: controller.signal });
    assert.equal(response.content, "Respuesta"); assert.equal(providerSignal.aborted, false);
    assert.equal(clock.pendingTimers(), 0);
    await clock.advanceAsync(20000); assert.equal(providerSignal.aborted, false);
    const error = Object.assign(new Error("Turno cerrado"), { code: "TURN_CLOSED" });
    controller.abort(error);
    assert.equal(providerSignal.aborted, true); assert.equal(providerSignal.reason, error);
    assert.equal(tracker.snapshot().calls, 1);
  } finally { controller.abort(); }
});
test("cancelación antes de la microtarea de invocación impide iniciar una llamada", async () => {
  const clock = createVirtualClock(0), controller = new AbortController(), tracker = createModelUsageTracker({ now: clock.now });
  const invoker = createModelInvoker({ tracker, clock, getRemainingMs: () => 60000 });
  let calls = 0;
  const outcome = invoker.invoke(() => { calls++; return { content: "No invocar" }; }, { signal: controller.signal }).catch(error => error);
  const error = Object.assign(new Error("Guardián apagado"), { code: "GUARDIAN_SHUTDOWN" });
  controller.abort(error);
  assert.equal(await outcome, error); assert.equal(calls, 0); assert.equal(clock.pendingTimers(), 0);
});
test("timeout cancela primer intento, reintenta una vez y registra consumo parcial real; ignora respuesta tardía", async () => {
  const clock = createVirtualClock(0), controller = new AbortController();
  const tracker = createModelUsageTracker({ component: "agent", now: clock.now });
  let calls = 0, release, firstSignal;
  const invoker = createModelInvoker({ tracker, clock, getRemainingMs: () => 60000 - clock.now(),
    onAttempt: attempt => ({ callInTurn: attempt, modelStep: 1 }) });
  const valid = { content: "respuesta", usage_metadata: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
  const pending = invoker.invoke(signal => {
    calls++; if (calls === 1) { firstSignal = signal; return new Promise(resolve => { release = resolve; }); }
    return valid;
  }, { signal: controller.signal, turn: 1 });
  await flushMicrotasks(); await clock.advanceAsync(20000);
  assert.equal(await pending, valid); assert.equal(firstSignal.aborted, true); assert.equal(calls, 2);
  release({ content: "no aceptar tarde", usage_metadata: { input_tokens: 99, output_tokens: 99, total_tokens: 198 } });
  await flushMicrotasks();
  const usage = tracker.snapshot();
  assert.equal(usage.calls, 2); assert.equal(usage.failedCalls, 1); assert.equal(usage.successfulCalls, 1);
  assert.equal(usage.usageComplete, false); assert.equal(usage.callsWithoutUsage, 1);
  assert.deepEqual(usage.reportedTokens, { input: 10, output: 2, total: 12 });
  assert.deepEqual(usage.callDetails.map(call => call.attempt), [1, 2]);
  assert.equal(usage.callDetails[0].errorCode, "MODEL_CALL_TIMEOUT");
  assert.equal(clock.pendingTimers(), 0);
});
test("dos timeouts no generan un tercer intento; si quedan menos de 25 segundos no reintenta", async () => {
  for (const deadline of [60000, 24000]) {
    const clock = createVirtualClock(0), tracker = createModelUsageTracker({ now: clock.now });
    let calls = 0;
    const invoker = createModelInvoker({ tracker, clock, getRemainingMs: () => deadline - clock.now() });
    const outcome = invoker.invoke(() => { calls++; return new Promise(() => {}); }, { signal: new AbortController().signal }).catch(error => error);
    await flushMicrotasks(); await clock.advanceAsync(20000);
    if (deadline === 60000) await clock.advanceAsync(20000);
    const error = await outcome;
    assert.equal(error.code, "MODEL_CALL_TIMEOUT"); assert.equal(calls, deadline === 60000 ? 2 : 1);
    if (deadline === 24000) assert.equal(error.retrySkipped, "INSUFFICIENT_TURN_TIME");
    assert.equal(clock.pendingTimers(), 0);
  }
});
test("cancelación del turno y otros errores no reintentan", async () => {
  for (const parentAbort of [true, false]) {
    const clock = createVirtualClock(0), tracker = createModelUsageTracker({ now: clock.now });
    const controller = new AbortController(); let calls = 0;
    const error = Object.assign(new Error("cancelado"), { code: parentAbort ? "TURN_TIMEOUT" : "PROVIDER_ERROR" });
    const invoker = createModelInvoker({ tracker, clock, getRemainingMs: () => 60000 });
    const outcome = invoker.invoke(() => { calls++; return parentAbort ? new Promise(() => {}) : Promise.reject(error); }, { signal: controller.signal }).catch(error => error);
    await flushMicrotasks(); if (parentAbort) controller.abort(error);
    assert.equal(await outcome, error); assert.equal(calls, 1); assert.equal(clock.pendingTimers(), 0);
  }
});

for (const status of [503, 429]) test("HTTP " + status + " espera 500 ms, reintenta exitosamente y registra ambos intentos", async () => {
  const clock = createVirtualClock(0), controller = new AbortController();
  const tracker = createModelUsageTracker({ component: "agent", now: clock.now });
  const failure = new GoogleGenerativeAIFetchError("PRIVATE_PROVIDER_ERROR", status, "", []);
  const valid = { content: "Respuesta", usage_metadata: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
  let calls = 0, firstSignal;
  const invoker = createModelInvoker({ tracker, clock, getRemainingMs: () => 60000 - clock.now(),
    onAttempt: attempt => ({ callInTurn: attempt, modelStep: 1 }) });
  const pending = invoker.invoke(signal => {
    if (++calls === 1) { firstSignal = signal; throw failure; }
    return valid;
  }, { signal: controller.signal, turn: 1 });
  try {
    await flushMicrotasks(); assert.equal(calls, 1); assert.equal(firstSignal.aborted, true);
    assert.equal(clock.pendingTimers(), 1); // Solo queda la espera, no el plazo del intento fallido.
    await clock.advanceAsync(499); assert.equal(calls, 1);
    await clock.advanceAsync(1); assert.equal(await pending, valid); assert.equal(calls, 2);
    const usage = tracker.snapshot();
    assert.deepEqual(usage.callDetails.map(call => [call.attempt, call.status]), [[1, "failed"], [2, "success"]]);
    assert.equal(usage.callDetails[0].httpStatus, status);
    assert.equal(usage.callDetails[0].errorClass, status === 503 ? "PROVIDER_5XX" : "RATE_LIMIT");
    assert.equal(usage.callsWithoutUsage, 1); assert.deepEqual(usage.reportedTokens, { input: 10, output: 2, total: 12 });
    assert.equal(JSON.stringify(usage).includes("PRIVATE_PROVIDER_ERROR"), false);
    assert.equal(clock.pendingTimers(), 0);
  } finally { controller.abort(); await pending.catch(() => {}); }
});

test("HTTP 400 y los demás 4xx de validación/autenticación no reintentan ni esperan", async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    const clock = createVirtualClock(0), tracker = createModelUsageTracker({ now: clock.now });
    const error = Object.assign(new Error("Solicitud inválida"), { response: { status },
      cause: Object.assign(new Error("Red"), { code: "ECONNRESET" }) });
    let calls = 0;
    const invoker = createModelInvoker({ tracker, clock, getRemainingMs: () => 60000 });
    await assert.rejects(invoker.invoke(() => { calls++; throw error; }, { signal: new AbortController().signal }), value => value === error);
    assert.equal(calls, 1); assert.equal(clock.pendingTimers(), 0);
    assert.equal(tracker.snapshot().callDetails[0].errorClass, "HTTP_4XX");
    assert.equal(tracker.snapshot().callDetails[0].httpStatus, status);
  }
});

test("transitorio sin tiempo para espera, llamada y margen no reintenta", async () => {
  const clock = createVirtualClock(0), tracker = createModelUsageTracker({ now: clock.now });
  const error = Object.assign(new Error("Proveedor no disponible"), { status: 503 });
  let calls = 0;
  const invoker = createModelInvoker({ tracker, clock, getRemainingMs: () => 25499 });
  await assert.rejects(invoker.invoke(() => { calls++; throw error; }, { signal: new AbortController().signal }), value => value === error);
  assert.equal(error.retrySkipped, "INSUFFICIENT_TURN_TIME"); assert.equal(calls, 1);
  assert.equal(tracker.snapshot().calls, 1); assert.equal(clock.pendingTimers(), 0);
});

test("revalida el margen al terminar la espera y admite exactamente 25 segundos restantes", async () => {
  for (const elapsed of [500, 501]) {
    const clock = createVirtualClock(0), controller = new AbortController(), tracker = createModelUsageTracker({ now: clock.now });
    const error = Object.assign(new Error("Proveedor no disponible"), { status: 503 });
    let calls = 0;
    const invoker = createModelInvoker({ tracker, clock, getRemainingMs: () => 25500 - clock.now() });
    const pending = invoker.invoke(() => { if (++calls === 1) throw error; return { content: "Respuesta" }; },
      { signal: controller.signal }).catch(value => value);
    try {
      await flushMicrotasks(); await clock.advanceAsync(elapsed);
      const result = await pending;
      assert.equal(calls, elapsed === 500 ? 2 : 1);
      if (elapsed === 500) assert.equal(result.content, "Respuesta");
      else { assert.equal(result, error); assert.equal(result.retrySkipped, "INSUFFICIENT_TURN_TIME"); }
      assert.equal(clock.pendingTimers(), 0);
    } finally { controller.abort(); await pending; }
  }
});

test("cortes de red con causa o envoltura del SDK se reintentan; argumentos y errores desconocidos no", async () => {
  const cycle = Object.assign(new Error("Red"), { code: "ECONNRESET" }); cycle.cause = cycle;
  const failures = [
    Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("Red"), { code: "ECONNRESET" }) }),
    Object.assign(new Error("Red"), { code: "EPIPE" }),
    Object.assign(new Error("Red"), { code: "UND_ERR_SOCKET" }), cycle,
    new GoogleGenerativeAIError("Error fetching from https://provider.invalid/endpoint: fetch failed"),
    new GoogleGenerativeAIError("Error reading from the stream"),
  ];
  for (const error of failures) {
    const clock = createVirtualClock(0), controller = new AbortController(), tracker = createModelUsageTracker({ now: clock.now });
    let calls = 0;
    const invoker = createModelInvoker({ tracker, clock, getRemainingMs: () => 60000 - clock.now() });
    const pending = invoker.invoke(() => { if (++calls === 1) throw error; return { content: "Respuesta" }; },
      { signal: controller.signal });
    try {
      await flushMicrotasks(); await clock.advanceAsync(500);
      assert.equal((await pending).content, "Respuesta"); assert.equal(calls, 2);
      assert.equal(tracker.snapshot().callDetails[0].errorClass, "NETWORK");
      assert.equal(clock.pendingTimers(), 0);
      assert.equal(JSON.stringify(safeErrorDetails(error)).includes("provider.invalid"), false);
    } finally { controller.abort(); await pending.catch(() => {}); }
  }
  for (const error of [new GoogleGenerativeAIRequestInputError("Argumentos inválidos"),
    new GoogleGenerativeAIError("No content is provided for sending chat message."),
    new GoogleGenerativeAIError("Failed to parse stream"), new TypeError("fetch failed")]) {
    assert.equal(classifyModelError(error).retryable, false);
  }
});

test("timeout y error transitorio comparten un único reintento por llamada", async () => {
  for (const timeoutFirst of [true, false]) {
    const clock = createVirtualClock(0), controller = new AbortController(), tracker = createModelUsageTracker({ now: clock.now });
    let calls = 0;
    const invoker = createModelInvoker({ tracker, clock, getRemainingMs: () => 60000 - clock.now() });
    const outcome = invoker.invoke(() => {
      calls++;
      if ((calls === 1) === timeoutFirst) return new Promise(() => {});
      throw Object.assign(new Error("Proveedor no disponible"), { status: 503 });
    }, { signal: controller.signal }).catch(error => error);
    try {
      await flushMicrotasks();
      if (!timeoutFirst) await clock.advanceAsync(500);
      await clock.advanceAsync(20000);
      const error = await outcome;
      assert.equal(calls, 2); assert.equal(tracker.snapshot().calls, 2); assert.equal(clock.pendingTimers(), 0);
      assert.equal(timeoutFirst ? error.status : error.code, timeoutFirst ? 503 : "MODEL_CALL_TIMEOUT");
      assert.deepEqual(tracker.snapshot().callDetails.map(call => call.errorClass), timeoutFirst
        ? ["MODEL_TIMEOUT", "PROVIDER_5XX"] : ["PROVIDER_5XX", "MODEL_TIMEOUT"]);
    } finally { controller.abort(); await outcome; }
  }
});

test("cancelar la espera por un transitorio impide iniciar o enviar el reintento", async () => {
  const clock = createVirtualClock(0), controller = new AbortController(), tracker = createModelUsageTracker({ now: clock.now });
  let calls = 0;
  const invoker = createModelInvoker({ tracker, clock, getRemainingMs: () => 60000 });
  const outcome = invoker.invoke(() => { calls++; throw Object.assign(new Error("Proveedor"), { status: 429 }); },
    { signal: controller.signal }).catch(error => error);
  await flushMicrotasks(); assert.equal(clock.pendingTimers(), 1);
  const shutdown = Object.assign(new Error("Guardián cerrado"), { code: "GUARDIAN_SHUTDOWN" });
  controller.abort(shutdown);
  assert.equal(await outcome, shutdown); assert.equal(clock.pendingTimers(), 0);
  await clock.advanceAsync(60000); assert.equal(calls, 1); assert.equal(tracker.snapshot().calls, 1);
});

test("dos intentos transitorios fallidos cuentan un solo turno técnico; el segundo turno deriva una vez", async () => {
  const clock = createVirtualClock(0), notifications = [];
  const waits = [0, 1].map(index => new Promise(resolve => { notifications[index] = resolve; }));
  const schedule = clock.setTimeout; let waitIndex = 0;
  clock.setTimeout = (fn, milliseconds) => {
    const id = schedule(fn, milliseconds);
    if (milliseconds === 500) notifications[waitIndex++]();
    return id;
  };
  const fail = () => { throw Object.assign(new Error("PRIVATE_PROVIDER_ERROR"), { status: 503 }); };
  const f = await consultationFixture({ model: scriptedModel([fail, fail, fail, fail]), modelClock: clock });
  const tasks = [];
  try {
    for (let index = 0; index < 2; index++) {
      const task = f.run({ user: "Consulta de prueba" }, index + 1);
      const outcome = task.then(result => ({ result }), error => ({ error })); tasks.push(outcome);
      await Promise.race([waits[index], outcome.then(value => { throw value.error ?? new Error("Terminó sin programar el reintento"); })]);
      assert.equal(f.transport.getOutgoing().length, index);
      assert.equal(f.world.getState().consecutiveTechnicalFailures, index);
      await clock.advanceAsync(500); const result = await task;
      assert.equal(result.usage.calls, 2); assert.equal(result.usage.failedCalls, 2);
      assert.equal(result.diagnostics[0].technicalFailure, true); assert.equal(result.guardian.outcome, "technical_error");
      assert.equal(result.diagnostics[0].errorClass, "PROVIDER_5XX");
      assert.equal(f.world.getState().consecutiveTechnicalFailures, index + 1);
      assert.equal(f.world.getState().humanHandoffRequired, index === 1);
      assert.equal(f.transport.getOutgoing()[index].text, index === 0 ? TECHNICAL_FAILURE_NOTICE : TECHNICAL_HANDOFF_MESSAGE);
      assert.equal(f.world.getState().guardianAlerts.length, index);
    }
    const alerts = f.world.getState().guardianAlerts;
    assert.equal(alerts[0].type, "TECHNICAL_FAILURE"); assert.equal(alerts[0].delivered, false);
    assert.equal(f.agent.getModelUsage().calls, 4);
    await f.run({ user: "Otro mensaje" }, 3);
    assert.equal(f.agent.getModelUsage().calls, 4); assert.equal(f.transport.getOutgoing().length, 2);
    assert.deepEqual(f.world.getState().guardianAlerts, alerts);
    assert.equal(clock.pendingTimers(), 0);
  } finally { await f.agent.dispose(); await Promise.all(tasks); f.close(); }
});

test("reintento transitorio exitoso reinicia la racha y no envía el aviso técnico", async () => {
  const clock = createVirtualClock(0); let notifyWait;
  const waiting = new Promise(resolve => { notifyWait = resolve; });
  const schedule = clock.setTimeout;
  clock.setTimeout = (fn, milliseconds) => { const id = schedule(fn, milliseconds); if (milliseconds === 500) notifyWait(); return id; };
  const f = await consultationFixture({ modelClock: clock, model: scriptedModel([
    () => { throw Object.assign(new Error("Proveedor"), { status: 429 }); },
    reply("responder", { texto: "Respuesta de prueba.", entendido: true }),
  ]) });
  const state = f.world.getState(); state.consecutiveTechnicalFailures = 1; f.world.setState(state);
  const task = f.run(); const outcome = task.then(result => ({ result }), error => ({ error }));
  try {
    await Promise.race([waiting, outcome.then(value => { throw value.error ?? new Error("Terminó sin programar el reintento"); })]);
    await clock.advanceAsync(500); const result = await task;
    assert.deepEqual(result.diagnostics, []); assert.equal(result.usage.calls, 2); assert.equal(result.guardian.outcome, "processed");
    assert.equal(f.world.getState().consecutiveTechnicalFailures, 0); assert.equal(f.world.getState().humanHandoffRequired, false);
    assert.deepEqual(f.world.getState().guardianAlerts, []);
    assert.deepEqual(f.transport.getOutgoing().map(message => message.text), ["Respuesta de prueba."]);
    assert.equal(clock.pendingTimers(), 0);
  } finally { await f.agent.dispose(); await outcome; f.close(); }
});

test("apagar el guardián durante los 500 ms cancela la espera sin llamadas ni mensajes tardíos", async () => {
  const clock = createVirtualClock(0); let notifyWait;
  const waiting = new Promise(resolve => { notifyWait = resolve; });
  const schedule = clock.setTimeout;
  clock.setTimeout = (fn, milliseconds) => { const id = schedule(fn, milliseconds); if (milliseconds === 500) notifyWait(); return id; };
  const f = await consultationFixture({ modelClock: clock, model: scriptedModel([
    () => { throw Object.assign(new Error("Proveedor"), { status: 503 }); },
    reply("responder", { texto: "No enviar después del cierre", entendido: true }),
  ]) });
  const outcome = f.run().then(result => ({ result }), error => ({ error }));
  try {
    await Promise.race([waiting, outcome.then(value => { throw value.error ?? new Error("Terminó sin programar el reintento"); })]);
    await f.agent.dispose(); assert.equal((await outcome).error.code, "GUARDIAN_SHUTDOWN");
    await clock.advanceAsync(60000);
    assert.equal(f.model.invocations.length, 1); assert.equal(f.agent.getModelUsage().calls, 1);
    assert.deepEqual(f.world.getEvents(), []); assert.deepEqual(f.transport.getOutgoing(), []);
    assert.equal(f.world.getState().consecutiveTechnicalFailures, 0);
    assert.equal(f.world.getState().humanHandoffRequired, false); assert.deepEqual(f.world.getState().guardianAlerts, []);
    assert.equal(clock.pendingTimers(), 0); assert.equal(f.world.clock.pendingTimers(), 0);
  } finally { await f.agent.dispose(); await outcome; f.close(); }
});

test("agente usa reintento sin ejecutar herramientas de una respuesta tardía", async () => {
  const clock = createVirtualClock(0); let release, notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const model = scriptedModel([() => { notifyStarted(); return new Promise(resolve => { release = resolve; }); },
    reply("responder", { texto: "Respuesta de prueba.", entendido: true })]);
  const f = await consultationFixture({ model, modelClock: clock, modelCallTimeoutMs: 1000 });
  const previous = f.world.getState(); previous.consecutiveTechnicalFailures = 1; f.world.setState(previous);
  const task = f.run();
  const outcome = task.then(result => ({ result }), error => ({ error }));
  try {
    await Promise.race([started, outcome.then(value => { throw value.error ?? new Error("El turno terminó antes de invocar el modelo"); })]);
    assert.equal(model.invocations.length, 1);
    await clock.advanceAsync(1000); const result = await task;
    assert.equal(result.usage.calls, 2); assert.equal(result.usage.failedCalls, 1);
    assert.deepEqual(result.diagnostics, []); assert.equal(result.guardian.outcome, "processed");
    assert.equal(f.world.getState().consecutiveTechnicalFailures, 0);
    assert.equal(f.world.getState().humanHandoffRequired, false); assert.deepEqual(f.world.getState().guardianAlerts, []);
    assert.deepEqual(f.world.getEvents().map(event => event.name), ["responder"]);
    release(reply("crear_pedido", { quoteId: "late" })); await flushMicrotasks();
    assert.deepEqual(f.world.getEvents().map(event => event.name), ["responder"]);
    assert.equal(f.transport.getOutgoing().length, 1);
    assert.equal(f.transport.getOutgoing()[0].text, "Respuesta de prueba.");
    assert.equal(model.invocations.length, 2);
    assert.equal(clock.pendingTimers(), 0);
  } finally { await f.agent.dispose(); await outcome; f.close(); }
});
test("apagar el guardián durante el reintento cancela la llamada y descarta ambas respuestas tardías", async () => {
  const clock = createVirtualClock(0), signals = [], releases = [], notifications = [];
  const started = [0, 1].map(index => new Promise(resolve => { notifications[index] = resolve; }));
  const model = scriptedModel([0, 1].map(index => (_messages, { signal }) => {
    signals[index] = signal; notifications[index]();
    return new Promise(resolve => { releases[index] = resolve; });
  }));
  const f = await consultationFixture({ model, modelClock: clock, modelCallTimeoutMs: 1000 });
  const task = f.run(); const outcome = task.then(result => ({ result }), error => ({ error }));
  const premature = () => outcome.then(value => { throw value.error ?? new Error("El turno terminó antes de lo esperado"); });
  try {
    await Promise.race([started[0], premature()]); assert.equal(model.invocations.length, 1);
    await clock.advanceAsync(1000);
    await Promise.race([started[1], premature()]); assert.equal(model.invocations.length, 2);
    assert.equal(signals[0].reason.code, "MODEL_CALL_TIMEOUT");
    await f.agent.dispose();
    assert.equal((await outcome).error.code, "GUARDIAN_SHUTDOWN");
    await flushMicrotasks();
    assert.equal(signals[1].aborted, true); assert.equal(signals[1].reason.code, "GUARDIAN_SHUTDOWN");
    assert.equal(clock.pendingTimers(), 0); assert.equal(f.world.clock.pendingTimers(), 0);
    releases[0](reply("crear_pedido", { quoteId: "late" }));
    releases[1](reply("responder", { texto: "No enviar después del cierre", entendido: true }));
    await flushMicrotasks(); await clock.advanceAsync(60000);
    assert.equal(model.invocations.length, 2);
    assert.deepEqual(f.world.getEvents(), []); assert.deepEqual(f.transport.getOutgoing(), []);
    assert.equal(f.world.getState().humanHandoffRequired, false);
    assert.equal(f.agent.getModelUsage().calls, 2);
  } finally { await f.agent.dispose(); await outcome; f.close(); }
});
test("apagar entre el timeout y el reintento impide iniciar el segundo intento", async () => {
  const clock = createVirtualClock(0); let notifyStarted, release;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const model = scriptedModel([() => { notifyStarted(); return new Promise(resolve => { release = resolve; }); },
    reply("responder", { texto: "No reintentar después del cierre", entendido: true })]);
  const f = await consultationFixture({ model, modelClock: clock, modelCallTimeoutMs: 1000 });
  const outcome = f.run().then(result => ({ result }), error => ({ error }));
  try {
    await Promise.race([started, outcome.then(value => { throw value.error ?? new Error("El turno terminó antes de invocar el modelo"); })]);
    clock.advance(1000); // Disparar el plazo sin ejecutar aún las continuaciones.
    await f.agent.dispose();
    assert.equal((await outcome).error.code, "GUARDIAN_SHUTDOWN");
    release(reply("responder", { texto: "No enviar tarde", entendido: true }));
    await flushMicrotasks(); await clock.advanceAsync(60000);
    assert.equal(model.invocations.length, 1); assert.equal(f.agent.getModelUsage().calls, 1);
    assert.deepEqual(f.world.getEvents(), []); assert.deepEqual(f.transport.getOutgoing(), []);
    assert.equal(f.world.getState().humanHandoffRequired, false);
    assert.equal(clock.pendingTimers(), 0); assert.equal(f.world.clock.pendingTimers(), 0);
  } finally { await f.agent.dispose(); await outcome; f.close(); }
});
test("apagar antes de iniciar el lote declarado impide llamadas, herramientas y envíos", async () => {
  const clock = createVirtualClock(0), model = scriptedModel([reply("responder", { texto: "No enviar", entendido: true })]);
  const f = await consultationFixture({ model, modelClock: clock });
  const outcome = f.run().then(result => ({ result }), error => ({ error }));
  try {
    await f.agent.dispose();
    assert.equal((await outcome).error.code, "GUARDIAN_SHUTDOWN");
    await clock.advanceAsync(60000); await f.world.clock.advanceAsync(60000);
    assert.equal(model.invocations.length, 0); assert.deepEqual(f.world.getEvents(), []);
    assert.deepEqual(f.transport.getOutgoing(), []); assert.equal(f.world.getState().humanHandoffRequired, false);
    assert.equal(clock.pendingTimers(), 0); assert.equal(f.world.clock.pendingTimers(), 0);
  } finally { await f.agent.dispose(); await outcome; f.close(); }
});
