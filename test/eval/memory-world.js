import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { createCatalogService } from "../../src/services/catalog.service.js";
import { TOOL_NAMES } from "./tool-names.js";
import { createVirtualClock } from "../helpers/virtual-clock.js";
import { assertCheckpointState } from "../../src/agents/guardian/attachments.js";
import { createMemoryOrderConfirmationRepository } from "../helpers/order-confirmation-memory.js";
import { createOrderPdfJobService } from "../../src/services/order-pdf-job.service.js";
import { createAgentAlertService } from "../../src/services/agent-alert.service.js";
import { createPaymentReceiptRepository } from "../../src/services/payment-receipt.repository.js";
import { receiptMemoryDatabase, memoryPrivateReceiptStorage } from "../helpers/receipt-memory.js";

export const EVAL_BANK_CONFIG = Object.freeze(JSON.parse(readFileSync(new URL("../fixtures/agent-bank.json", import.meta.url), "utf8")));
export const EVAL_AGENT_CONFIG = Object.freeze(JSON.parse(readFileSync(new URL("../fixtures/agent-config.json", import.meta.url), "utf8")));

export function createClock(initialTime) {
  return createVirtualClock(initialTime);
}

export function createMemoryWorld(fixtures, { clock, transport, bankConfig = EVAL_BANK_CONFIG,
  agentConfig = Object.hasOwn(fixtures, "agentConfig") ? fixtures.agentConfig : EVAL_AGENT_CONFIG, orderFaults = {},
  generatePdf = async () => null, sendPdf = (...args) => transport.sendPdf(...args), receiptFaults = {} }) {
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
  const handoffs = repository([], "id");
  const alertRequests = repository([], "id");
  const paymentReceipts = repository([], "id");
  let configuration = structuredClone(agentConfig);
  const quotes = repository([], "quoteId");
  const profiles = repository([], "phoneNumber");
  const guardianEvents = [];
  const events = [];
  const handlers = new Map();
  let toolGate = null;
  let chatId = null;
  let active = { phase: "setup", turn: 0, signal: null };
  let executionPhase = { phase: "setup" };
  const catalog = createCatalogService({
    now: clock.now,
    repository: {
      async readCatalog() { return { categories: categories.list(), products: products.list(), policies: policies.list() }; },
      async getProduct(id) { return products.get(id); },
      async getCategory(id) { return categories.get(id); },
    },
  });
  const world = {
    clock, now: clock.now, transport, orders, carts, checkpoints, uploads, handoffs, quotes, profiles, alertRequests, paymentReceipts,
    agentConfig: { get: async () => { assertOpen(); return structuredClone(configuration); },
      set: value => { assertOpen(); configuration = structuredClone(value); } },
    agentAlerts: createAgentAlertService({ repository: { async request(value, { signal } = {}) {
      signal?.throwIfAborted(); assertOpen();
      const current = alertRequests.get(value.id); if (current) return current;
      alertRequests.set(value.id, value); return value;
    } } }),
    recordGuardianEvent: event => guardianEvents.push({ ...structuredClone(event), time: clock.now() }),
    getGuardianEvents: () => structuredClone(guardianEvents),
    setExecutionPhase: (phase, details = {}) => { executionPhase = { phase, ...details }; },
    getExecutionPhase: () => structuredClone(executionPhase),
    // Solo operaciones de lectura del servicio central. No hay CRUD admin disponible.
    catalog: Object.fromEntries(["getCategories", "getProduct", "searchProducts", "listPolicies",
      "getProductForPricing", "getCategoryForPricing"].map(name => [name, catalog[name]])),
    initialize(initial) {
      assertOpen();
      // Antes de instalar herramientas o preparar cotizacionMostrada. Cada
      // caso parte de la configuración base; el contexto solo cambia el umbral.
      configuration = structuredClone(agentConfig);
      if (initial.agentConfig) configuration = { ...configuration, ...structuredClone(initial.agentConfig) };
      chatId = initial.state.whatsappChatId;
      checkpoints.set(chatId, initial.state);
      if (initial.cart) carts.set(chatId, initial.cart);
      world.scenario = structuredClone(initial.scenario);
    },
    getState: () => checkpoints.get(chatId),
    setState: state => checkpoints.set(chatId, assertCheckpointState(state)),
    getCart() {
      const cart = carts.get(chatId);
      if (cart && cart.expiresAt <= clock.now()) { carts.delete(chatId); return null; }
      return cart;
    },
    setCart: cart => { if (cart === null) carts.delete(chatId); else carts.set(chatId, cart); },
    cartRepository: {
      get(id) { if (id !== chatId) throw new Error("Carrito de otro chat"); return world.getCart(); },
      set(id, cart, { expectedRevision, signal } = {}) {
        if (id !== chatId) throw new Error("Carrito de otro chat"); signal?.throwIfAborted();
        const current = world.getCart();
        if ((current ? current.revision ?? 0 : null) !== expectedRevision) throw Object.assign(new Error("El carrito cambió; volvé a consultarlo."), { code: "CARRITO_CAMBIO", field: "cart", statusCode: 400 });
        world.setCart(cart);
      },
      delete(id) { if (id !== chatId) throw new Error("Carrito de otro chat"); assertOpen(); carts.delete(id); },
    },
    quoteRepository: { get: id => quotes.get(id), set: (id, quote) => quotes.set(id, quote) },
    async uploadCustomizationImage({ base64, mimetype }, { signal } = {}) {
      assertOpen(); signal?.throwIfAborted();
      const id = "upload-" + (uploads.list().length + 1);
      const imageUrl = "https://example.test/" + id + ".png";
      // Solo metadatos; los bytes sintéticos se consumen dentro de este turno.
      uploads.set(id, { id, imageUrl, mimeType: mimetype, size: Buffer.byteLength(base64, "base64"), time: clock.now() });
      return imageUrl;
    },
    async getOwnProfile(phone) { return profiles.get(phone); },
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
      executionPhase = { phase: "agent_adapter" };
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
      Object.defineProperty(event, "startedAt", { value: startedAt });
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
    getEvents: () => structuredClone(events.map(event => ({ ...event,
      ...(event.status === "pending" ? { durationMs: performance.now() - event.startedAt, incomplete: true } : { incomplete: false }) }))),
    snapshot() {
      return {
        catalog: { categories: categories.list(), products: products.list() },
        policies: policies.list(), orders: orders.list(), cart: world.getCart(),
        paymentConfig: structuredClone(bankConfig), orderPersistence: world.orderRepository.inspect(),
        agentConfig: structuredClone(configuration), alertRequests: alertRequests.list(),
        paymentReceipts: paymentReceipts.list().map(value => Object.fromEntries(["id", "status", "orderId", "orderNumber", "mimeType", "filename", "createdAt", "expiresAt", "acknowledgementDelivered"]
          .filter(key => value[key] !== undefined).map(key => [key, value[key]]))),
      };
    },
    close() { world.orderJobs.stop(); closed = true; transport.close(); },
  };
  world.bankConfig = structuredClone(bankConfig);
  world.receiptStorage = memoryPrivateReceiptStorage({ assertOpen });
  world.receiptRepository = createPaymentReceiptRepository({ db: receiptMemoryDatabase({ orders,
    receipts: paymentReceipts, alerts: alertRequests, assertOpen, faults: receiptFaults }), now: clock.now });
  world.orderRepository = createMemoryOrderConfirmationRepository({ catalog: world.catalog, cartRepository: world.cartRepository,
    quoteRepository: world.quoteRepository, orders, agentConfig: world.agentConfig, now: clock.now, assertOpen, faults: orderFaults });
  world.orderJobs = createOrderPdfJobService({ repository: world.orderRepository,
    transport: { sendText: transport.sendText, sendPdf }, generatePdf, now: clock.now, clock });
  world.drainBackgroundJobs = () => world.orderJobs.drain();
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
