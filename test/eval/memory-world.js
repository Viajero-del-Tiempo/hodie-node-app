import { performance } from "node:perf_hooks";
import { createCatalogService } from "../../src/services/catalog.service.js";
import { TOOL_NAMES } from "./tool-names.js";

export function createClock(initialTime) {
  if (!Number.isFinite(initialTime)) throw new Error("Reloj inicial inválido");
  let time = initialTime;
  return { now: () => time, advance: milliseconds => {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("Avance de reloj inválido");
    time += milliseconds;
  } };
}

export function createMemoryWorld(fixtures, { clock, transport }) {
  let closed = false;
  const assertOpen = () => { if (closed) throw new Error("La ejecución ya terminó"); };
  function repository(rows, key) {
    const entries = new Map(rows.map(row => [row[key], structuredClone(row)]));
    return {
      get: id => structuredClone(entries.get(id) ?? null),
      list: () => structuredClone([...entries.values()]),
      set: (id, value) => { assertOpen(); entries.set(id, structuredClone(value)); },
      delete: id => { assertOpen(); entries.delete(id); },
      clear: () => { assertOpen(); entries.clear(); },
    };
  }
  const categories = repository(fixtures.categories.map(item => ({ active: true, description: "", ...item })), "id");
  const products = repository(fixtures.products.map(item => ({
    schemaVersion: 2, active: true, slug: item.id, description: "", imageUrls: [],
    tags: [], attributes: {}, optionNames: [], packagingOptions: [], ...item,
    variants: item.variants.map(variant => ({ active: true, imageUrls: [], ...variant })),
    customization: { allowed: false, allowsText: false, allowsImage: false, notes: "", ...item.customization },
    skus: item.variants.map(variant => variant.sku),
  })), "id");
  const policies = repository(Object.entries(fixtures.policies).map(([id, text]) => ({ id, title: id, text })), "id");
  const orders = repository(fixtures.orders, "orderNumber");
  const carts = repository([], "id");
  const checkpoints = repository([], "id");
  const uploads = repository([], "id");
  const events = [];
  const handlers = new Map();
  let toolGate = null;
  let chatId = null;
  let active = { phase: "setup", turn: 0, signal: null };
  const catalog = createCatalogService({
    now: clock.now,
    repository: {
      async readCatalog() { return { categories: categories.list(), products: products.list(), policies: policies.list() }; },
      async getProduct(id) { return products.get(id); },
      async getCategory(id) { return categories.get(id); },
    },
  });
  const world = {
    clock, now: clock.now, transport, orders, carts, checkpoints, uploads,
    // Solo operaciones de lectura del servicio central. No hay CRUD admin disponible.
    catalog: Object.fromEntries(["getCategories", "getProduct", "searchProducts", "listPolicies",
      "getProductForPricing", "getCategoryForPricing"].map(name => [name, catalog[name]])),
    initialize(initial) {
      assertOpen();
      chatId = initial.state.whatsappChatId;
      checkpoints.set(chatId, initial.state);
      if (initial.cart) carts.set(chatId, initial.cart);
      world.scenario = structuredClone(initial.scenario);
    },
    getState: () => checkpoints.get(chatId),
    setState: state => checkpoints.set(chatId, state),
    getCart() {
      const cart = carts.get(chatId);
      if (cart && cart.expiresAt <= clock.now()) { carts.delete(chatId); return null; }
      return cart;
    },
    setCart: cart => { if (cart === null) carts.delete(chatId); else carts.set(chatId, cart); },
    getHistory() {
      const state = world.getState();
      return state.messages.slice(state.sessionCutoff).slice(-20).map(message => ({
        role: message.role, content: message.content,
      }));
    },
    registerTool(name, handler, { real = false } = {}) {
      assertOpen();
      if (!TOOL_NAMES.includes(name) || typeof handler !== "function") throw new Error("Herramienta no canónica o handler inválido: " + name);
      handlers.set(name, { handler, real });
    },
    isRealTool: name => handlers.get(name)?.real === true,
    setToolGate(gate) {
      assertOpen();
      if (typeof gate !== "function") throw new Error("Gate de herramientas inválido");
      toolGate = gate;
    },
    beginTurn(turn, signal) {
      assertOpen();
      active = { phase: "case", turn, signal };
      transport.beginTurn(turn);
    },
    async invokeTool(name, args = {}, options = {}) {
      assertOpen();
      const context = { ...active, ...options };
      if (context.signal?.aborted) throw context.signal.reason;
      const startedAt = performance.now();
      const event = {
        id: "tool-" + (events.length + 1), type: "tool", phase: context.phase,
        turn: context.turn, name, args: structuredClone(args), status: "pending",
        handlerInvoked: false,
      };
      events.push(event);
      try {
        const denied = toolGate?.(name, args);
        const registered = handlers.get(name);
        if (!denied && !registered) throw Object.assign(new Error("Herramienta no disponible: " + name), { code: "TOOL_UNAVAILABLE" });
        let result = denied;
        if (!denied) {
          event.handlerInvoked = true;
          result = await registered.handler(structuredClone(args), { world, transport, ...context });
        }
        assertOpen();
        if (context.signal?.aborted) throw context.signal.reason;
        event.result = structuredClone(result ?? null);
        event.status = "completed";
        return structuredClone(result);
      } catch (error) {
        event.status = "error";
        event.error = { code: error.code ?? "TOOL_ERROR", message: error.message };
        throw error;
      } finally {
        event.durationMs = performance.now() - startedAt;
      }
    },
    getEvents: () => structuredClone(events),
    snapshot() {
      return {
        catalog: { categories: categories.list(), products: products.list() },
        policies: policies.list(), orders: orders.list(), cart: world.getCart(),
      };
    },
    close() { closed = true; transport.close(); },
  };
  world.registerTool("responder", async ({ texto, entendido, quoteIdMostrado }) => {
    if (typeof texto !== "string" || !texto.trim() || typeof entendido !== "boolean") throw new Error("Respuesta inválida");
    if (quoteIdMostrado !== undefined) throw new Error("El responder de prueba no registra cotizaciones; use la herramienta real");
    await transport.sendText(texto);
    return { code: "OK", entendido };
  });
  world.registerTool("derivar", async ({ motivo }) => {
    if (typeof motivo !== "string" || !motivo.trim()) throw new Error("Falta el motivo");
    const state = world.getState();
    state.humanHandoffRequired = true;
    state.humanHandoffReason = motivo;
    world.setState(state);
    return { code: "OK" };
  });
  return world;
}
