import test from "node:test";
import assert from "node:assert/strict";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { readFile } from "node:fs/promises";
import { consultationFixture, scriptedModel, reply } from "./helpers/consultation-fixtures.js";
import { evalFixtures, evalCart } from "./helpers/eval-fixtures.js";
import { deterministicChecks } from "./eval/checks.js";
import { createConsultationAgent } from "../src/agents/consultation/agent.js";
import { parseAgentThinkingBudget, resolveAgentModelConfig } from "../src/agents/consultation/model-config.js";

test("presupuesto del agente valida números, usa 512 por defecto y prioriza override sin mutar entorno", () => {
  assert.deepEqual(resolveAgentModelConfig({ env: {} }), { options: { thinkingBudget: 512 },
    thinking: { mode: "budget", thinkingBudget: 512, source: "default" } });
  for (const value of [0, 512, 1024]) {
    assert.equal(parseAgentThinkingBudget(String(value)), value);
    assert.equal(resolveAgentModelConfig({ env: { AGENT_THINKING_BUDGET: String(value) } }).options.thinkingBudget, value);
  }
  for (const value of ["", " ", "1.5", "1e3", "abc", "-1", -1, 2.5, NaN, Infinity, true, null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseAgentThinkingBudget(value), { code: "INVALID_AGENT_THINKING_BUDGET" });
  }
  const env = Object.freeze({ AGENT_THINKING_BUDGET: "2048" });
  assert.deepEqual(resolveAgentModelConfig({ env, thinkingBudget: 0 }), { options: { thinkingBudget: 0 },
    thinking: { mode: "budget", thinkingBudget: 0, source: "override" } });
  assert.equal(env.AGENT_THINKING_BUDGET, "2048");
  assert.equal(resolveAgentModelConfig({ env: { AGENT_THINKING_BUDGET: "invalid" }, thinkingBudget: 512 }).options.thinkingBudget, 512);
  assert.throws(() => resolveAgentModelConfig({ env: { AGENT_THINKING_BUDGET: "invalid" } }), { code: "INVALID_AGENT_THINKING_BUDGET" });
});
test("factory del agente recibe exclusivamente su presupuesto y metadata describe lo enviado", async () => {
  for (const [env, thinkingBudget, expected] of [[{}, undefined, { thinkingBudget: 512 }], [{ AGENT_THINKING_BUDGET: "512" }, undefined, { thinkingBudget: 512 }],
    [{ AGENT_THINKING_BUDGET: "2048" }, 0, { thinkingBudget: 0 }]]) {
    const requests = [];
    const agent = await createConsultationAgent({ runtime: {}, registry: {}, prompt: "Prueba de configuración.", modelEnv: env, thinkingBudget,
      modelFactory: options => { requests.push(options); return { model: "test-budget-model" }; } });
    assert.deepEqual(requests, [expected]); assert.equal(agent.metadata.model, "test-budget-model");
    assert.equal(agent.metadata.thinking.thinkingBudget, expected.thinkingBudget);
    assert.equal(agent.metadata.thinking.mode, "budget");
    assert.equal(agent.metadata.thinking.source, thinkingBudget !== undefined ? "override" : env.AGENT_THINKING_BUDGET === undefined ? "default" : "env");
    assert.equal(agent.metadata.modelInjected, true); assert.equal(agent.getModelUsage().calls, 0);
  }
  let called = false;
  await assert.rejects(createConsultationAgent({ runtime: {}, registry: {}, prompt: "Prueba", modelEnv: { AGENT_THINKING_BUDGET: "bad" },
    modelFactory: () => { called = true; } }), { code: "INVALID_AGENT_THINKING_BUDGET" });
  assert.equal(called, false);
  const injected = await createConsultationAgent({ runtime: {}, registry: {}, prompt: "Prueba", model: { model: "test-injected" },
    modelEnv: {}, thinkingBudget: 512 });
  assert.deepEqual(injected.metadata.thinking, { mode: "unknown", thinkingBudget: null, source: "injected_model" });
  assert.equal(injected.metadata.requestedThinking.thinkingBudget, 512);
});

test("ciclo búsqueda/detalle/respuesta usa datos cambiantes de herramientas y conserva firmas del modelo", async () => {
  for (const price of [100, 234]) {
    const fixtures = evalFixtures(); fixtures.products[0].variants[0].price = price;
    const first = reply("buscar_productos", { consulta: "Alfa" });
    first.additional_kwargs = { signature_sentinel: "PRIVATE_MODEL_SIGNATURE" };
    const model = scriptedModel([first, messages => {
      assert.equal(messages.at(-2), first);
      assert.equal(messages.at(-1).name, "buscar_productos");
      assert.equal(messages.at(-1).tool_call_id, first.tool_calls[0].id);
      const data = JSON.parse(messages.at(-1).content);
      return reply("ver_producto", { productId: data.products[0].id });
    }, messages => {
      const data = JSON.parse(messages.at(-1).content);
      return reply("responder", { texto: data.product.name + ": " + data.product.variants[0].price, entendido: true });
    }]);
    const f = await consultationFixture({ fixtures, model });
    try {
      const result = await f.run({ user: "Información de Producto Alfa" });
      assert.equal(f.transport.getOutgoing()[0].text, "Producto Alfa: " + price);
      assert.deepEqual(f.world.getEvents().map(event => event.name), ["buscar_productos", "ver_producto", "responder"]);
      assert.equal(result.usage.calls, 3);
      assert.deepEqual(result.usage.reportedTokens, { input: 30, output: 6, total: 36 });
      assert.ok(deterministicChecks({ handoff: "no" }, { tools: f.world.getEvents(), finalHandoff: false,
        turns: [{ number: 1, handoffBefore: false, handoffAfter: false, outgoing: f.transport.getOutgoing() }] }).every(check => check.pass));
      const context = JSON.parse(model.invocations[0].messages[1].content.split("\n").slice(1).join("\n"));
      assert.equal(context.categories[0].name, "Categoría Alfa");
      assert.equal(JSON.stringify(context).includes("Producto Alfa"), false);
      const searchSchema = model.bindings[1].definitions[0].functionDeclarations.find(tool => tool.name === "buscar_productos");
      assert.deepEqual(Object.keys(searchSchema.parameters.properties.opciones.properties), ["finish"]);
    } finally { f.close(); }
  }
});
test("contexto del servidor recorta historial, conserva ráfaga en orden y no envía productos completos, datos ajenos ni bytes", async () => {
  const fixtures = evalFixtures();
  fixtures.orders.push({ ...fixtures.orders[0], orderNumber: "other-order", userPhoneNumber: "595900000002" });
  const conversacion = Array.from({ length: 25 }, (_, i) => ({ cliente: "Anterior " + i }));
  const model = scriptedModel([reply("responder", { texto: "Respuesta", entendido: true })]);
  const f = await consultationFixture({ fixtures, model,
    context: { telefonoCliente: "595900000001", conversacion, carrito: evalCart() } });
  try {
    await f.run({ user: "Primero", burst: ["Segundo", "Tercero"] });
    const messages = model.invocations[0].messages;
    assert.equal(messages.length, 23); // prompt + contexto + 20 previos + entrada agrupada
    assert.equal(messages[2].content, "Anterior 5");
    assert.equal(messages.at(-1).content, "Primero\nSegundo\nTercero");
    const context = JSON.parse(messages[1].content.split("\n").slice(1).join("\n"));
    assert.equal(context.identity.phoneVerified, true);
    assert.deepEqual(context.orders, [{ orderNumber: "test-order-a", status: "pending" }]);
    assert.equal(context.cart.lines[0].variantId, "variant-a");
    assert.equal(context.orders[0].items, undefined);
    assert.equal(context.timezone, "America/Asuncion");
    assert.equal(f.transport.getOutgoing().length, 1);
    assert.equal(f.world.getState().messages.length, 25); // El runner administra el historial.
  } finally { f.close(); }
});
test("handoff activo evita modelo y envíos sin importar el tiempo transcurrido", async () => {
  const f = await consultationFixture();
  try {
    const state = f.world.getState(); state.humanHandoffRequired = true; state.lastActivityAt = 0; f.world.setState(state);
    const result = await f.run();
    assert.equal(result.usage.calls, 0);
    assert.equal(f.model.invocations.length, 0);
    assert.deepEqual(f.transport.getOutgoing(), []);
    assert.deepEqual(f.world.getEvents(), []);
  } finally { f.close(); }
});
test("errores de argumentos se devuelven al modelo; responder inválido no cuenta como cierre", async () => {
  const model = scriptedModel([reply("responder", { texto: "No se debe enviar" }), messages => {
    assert.equal(JSON.parse(messages.at(-1).content).field, "entendido");
    return reply("responder", { texto: "Respuesta válida", entendido: true });
  }]);
  const f = await consultationFixture({ model });
  try {
    await f.run();
    assert.equal(f.transport.getOutgoing().length, 1);
    assert.equal(f.transport.getOutgoing()[0].text, "Respuesta válida");
    assert.equal(f.world.getEvents()[0].result.code, "ARGUMENTOS_INVALIDOS");
    const checks = deterministicChecks({ handoff: "no" }, { tools: f.world.getEvents(), finalHandoff: false,
      turns: [{ number: 1, handoffBefore: false, handoffAfter: false, outgoing: f.transport.getOutgoing() }] });
    assert.equal(checks.find(check => check.kind === "turn_end").pass, true);
  } finally { f.close(); }
});
test("siete lecturas y el cierre usan ocho herramientas pero solo dos invocaciones al modelo", async () => {
  const calls = Array.from({ length: 7 }, (_, i) => ({ id: "read-" + i, name: "ver_producto", args: { productId: "product-a" }, type: "tool_call" }));
  const model = scriptedModel([new AIMessage({ content: "", tool_calls: calls,
    usage_metadata: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }), reply("responder", { texto: "Respuesta", entendido: true })]);
  const f = await consultationFixture({ model });
  try {
    const result = await f.run();
    assert.equal(f.world.getEvents().length, 8);
    assert.equal(result.usage.calls, 2);
    assert.deepEqual(model.bindings[1].options.allowedFunctionNames, ["responder"]);
    assert.equal(f.transport.getOutgoing().length, 1);
  } finally { f.close(); }
});
test("lotes que superan el presupuesto, omiten la reserva o continúan después del cierre no ejecutan efectos", async () => {
  for (const count of [8, 9]) {
    const model = scriptedModel([new AIMessage({ content: "", tool_calls: Array.from({ length: count }, (_, i) => ({
      id: "read-" + i, name: "ver_producto", args: { productId: "product-a" }, type: "tool_call",
    })) })]);
    const f = await consultationFixture({ model });
    try {
      const result = await f.run();
      assert.equal(result.diagnostics[0].code, "TOOL_LIMIT");
      assert.equal(f.world.getEvents().length, 0);
      assert.equal(f.world.getState().humanHandoffRequired, true);
      assert.equal(f.transport.getOutgoing().length, 1);
    } finally { f.close(); }
  }
  for (const names of [["responder", "ver_producto"], ["responder", "responder"]]) {
    const model = scriptedModel([new AIMessage({ content: "", tool_calls: names.map((name, i) => ({
      name, id: "call-" + i, args: name === "responder" ? { texto: "No enviar", entendido: true } : { productId: "product-a" }, type: "tool_call",
    })) })]);
    const f = await consultationFixture({ model });
    try {
      assert.equal((await f.run()).diagnostics[0].code, "INVALID_TOOL_BATCH");
      assert.equal(f.world.getEvents().length, 0);
      assert.equal(f.transport.getOutgoing().length, 1);
    } finally { f.close(); }
  }
});
test("intentos de herramientas ajenas consumen presupuesto y no modifican catálogo, pedidos o carrito", async () => {
  const model = scriptedModel([...Array.from({ length: 7 }, () => reply("modificar_precio", { price: 1 })),
    reply("responder", { texto: "No puedo modificar precios por este chat.", entendido: true })]);
  const f = await consultationFixture({ model, context: { carrito: evalCart() } });
  try {
    const before = f.world.snapshot();
    await f.run();
    assert.equal(f.world.getEvents().length, 8);
    assert.ok(f.world.getEvents().slice(0, 7).every(event => event.result.code === "HERRAMIENTA_NO_DISPONIBLE"));
    assert.deepEqual(f.world.snapshot().catalog, before.catalog);
    assert.deepEqual(f.world.snapshot().orders, before.orders);
    assert.deepEqual(f.world.getCart(), before.cart);
    assert.deepEqual(model.bindings.at(-1).options.allowedFunctionNames, ["responder"]);
  } finally { f.close(); }
});
test("sin cierre o con error del proveedor se deriva por código una vez y el siguiente turno queda en silencio", async () => {
  for (const step of [new AIMessage("Texto fuera de responder"), () => { throw new Error("PRIVATE_PROVIDER_ERROR"); }]) {
    const f = await consultationFixture({ model: scriptedModel([step]) });
    try {
      const result = await f.run();
      assert.equal(result.diagnostics.length, 1);
      assert.equal(f.world.getState().humanHandoffRequired, true);
      assert.equal(f.transport.getOutgoing().length, 1);
      assert.equal(f.transport.getOutgoing()[0].text.includes("PRIVATE_PROVIDER_ERROR"), false);
      await f.run({ user: "Otro mensaje" }, 2);
      assert.equal(f.model.invocations.length, 1);
      assert.equal(f.transport.getOutgoing().length, 1);
    } finally { f.close(); }
  }
});
test("cancelación externa impide envíos y escrituras tardías aunque el modelo ignore AbortSignal", async () => {
  let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  const model = scriptedModel([() => { started(); return new Promise(resolve => { finish = resolve; }); }]);
  const f = await consultationFixture({ model });
  try {
    const controller = new AbortController();
    const pending = f.run(undefined, 1, controller.signal);
    await ready;
    controller.abort(new Error("Cancelado por el runner"));
    await assert.rejects(pending, /Cancelado por el runner/);
    finish(reply("responder", { texto: "No enviar tarde", entendido: true }));
    await Promise.resolve();
    assert.deepEqual(f.transport.getOutgoing(), []);
    assert.equal(f.world.getState().humanHandoffRequired, false);
    assert.equal(f.agent.getModelUsage().calls, 1);
    assert.equal(f.agent.getModelUsage().failedCalls, 1);
  } finally { f.close(); }
});
test("timeout interno fuerza cierre antes del timeout del runner y no acepta una respuesta tardía", async () => {
  let finish;
  const model = scriptedModel([() => new Promise(resolve => { finish = resolve; })]);
  const f = await consultationFixture({ model, timeoutMs: 10 });
  try {
    const result = await f.run();
    assert.equal(result.diagnostics[0].code, "AGENT_TIMEOUT");
    assert.equal(f.world.getState().humanHandoffRequired, true);
    assert.equal(result.usage.callsWithoutUsage, 1);
    finish(reply("responder", { texto: "No enviar tarde", entendido: true }));
    await Promise.resolve();
    assert.equal(f.transport.getOutgoing().length, 1);
    assert.equal(f.world.getEvents().length, 0);
  } finally { f.close(); }
});
test("entendido mantiene el contador sin implementar todavía la escalada de cuatro intentos", async () => {
  const f = await consultationFixture({ model: scriptedModel([reply("responder", { texto: "Repregunta", entendido: false })]) });
  try {
    const state = f.world.getState(); state.consecutiveMisunderstandings = 3; f.world.setState(state);
    await f.run();
    assert.equal(f.world.getState().consecutiveMisunderstandings, 4);
    assert.equal(f.world.getState().humanHandoffRequired, false);
  } finally { f.close(); }
});
test("prompt habilita 4A, preserva seguridad y restricciones temporales de entrega 5", async () => {
  const prompt = await readFile(new URL("../src/agents/prompts/agente.md", import.meta.url), "utf8");
  assert.equal(prompt.includes("TEMPORAL ENTREGA 4"), false);
  assert.ok(prompt.includes("<!-- TEMPORAL ENTREGA 5:"));
  assert.ok(prompt.includes("<!-- FIN TEMPORAL ENTREGA 5 -->"));
  for (const rule of ["sin afirmar que es un producto de HoDie", "confirmarTexto", "Subtotal de productos", "confirmedRuc", "acknowledgeRucMismatch", "responder.quoteIdMostrado", "nunca hagas cuentas", "crear_pedido todavía no está disponible"]) assert.ok(prompt.includes(rule), rule);
  assert.equal(prompt.includes("Producto Alfa"), false);
  for (const rule of ["Seguí pendientes del servidor en su orden", "nombres y precios", "packagingType:null",
    "cotizar con lineas", "no prometas que se puede producir", "cliente posterga la compra",
    "política vigente consultada y no insistas"]) assert.ok(prompt.includes(rule), rule);
  assert.ok(prompt.includes("no llames a carrito_ver para releerlos"));
  assert.ok(prompt.includes("pendientes empieza con informar_subtotal, llamá a cotizar"));
});

test("prompt procesa y responde los datos recibidos en el turno antes de usar pendientes para la próxima pregunta", async () => {
  const prompt = (await readFile(new URL("../src/agents/prompts/agente.md", import.meta.url), "utf8")).replace(/\s+/gu, " ");
  assert.ok(prompt.includes("Registrá primero los datos que el cliente aporta con su herramienta y respondé sobre ellos en ese mismo turno"));
  assert.ok(prompt.includes("pendientes indica qué preguntar después, nunca impide procesar lo recibido"));
  assert.ok(prompt.includes("Después de datos_envio, comunicá modalidad, costo y requisito de cédula de options en ese mismo turno"));
  assert.ok(prompt.includes("shippingCost es el cargo del pedido; label explica el flete"));
  assert.ok(prompt.includes("Pedí cédula solo si requiresRecipientDocument:true, sin estimar flete"));
  assert.ok(prompt.includes("Seguí pendientes del servidor en su orden"));
});
test("prompt exige precios del resultado al listar y desde para precios que varían entre variantes", async () => {
  const prompt = (await readFile(new URL("../src/agents/prompts/agente.md", import.meta.url), "utf8")).replace(/\s+/gu, " ");
  assert.ok(prompt.includes("Al listar productos, incluí el precio de cada uno devuelto por buscar_productos"));
  assert.ok(prompt.includes('si varía entre variantes, indicá "desde" con priceFrom'));
  assert.equal(prompt.includes("Producto Beta"), false);
});
test("prompt explica políticas completas y ofrece una persona ante cualquier condición distinta sin prometer derivación", async () => {
  const prompt = (await readFile(new URL("../src/agents/prompts/agente.md", import.meta.url), "utf8")).replace(/\s+/gu, " ");
  assert.ok(prompt.includes("Consultá consultar_politicas para responder sobre condiciones del negocio"));
  assert.ok(prompt.includes("Transmití todas las condiciones y restricciones de la política que explicás, sin resumirlas ni omitirlas, aunque requiera más de cuatro oraciones"));
  assert.ok(prompt.includes("Ante pedidos de condiciones distintas de las políticas"));
  for (const condition of ["descuentos", "rebajas", "regateo", "cambios de precio", "pago al recibir", "entregas personales", "anticipos u otras"]) {
    assert.ok(prompt.includes(condition), condition);
  }
  assert.ok(prompt.includes("lo vigente consultado y ofrecé hablar con una persona del equipo sin afirmar derivación"));
  assert.ok(prompt.includes("desde el chat no podés modificarlos e informá el precio vigente de las herramientas"));
  assert.ok(prompt.includes("solo afirmá que son fijos si lo indica consultar_politicas"));
  assert.equal(prompt.includes("Condición ficticia Alfa"), false);
});
