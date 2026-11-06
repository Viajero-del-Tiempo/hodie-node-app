import { createMemoryWorld, createClock } from "../eval/memory-world.js";
import { createFakeWhatsApp } from "../eval/fake-whatsapp.js";
import { buildInitialState } from "../eval/initial-state.js";
import { createPurchaseTools } from "../../src/agents/consultation/purchase-tools.js";
import { createResponder } from "../../src/agents/consultation/terminal.js";
import { createToolRegistry } from "../../src/agents/consultation/tool-registry.js";
import { evalFixtures, evalCart } from "./eval-fixtures.js";
import { FIXTURE_NOW } from "./consultation-fixtures.js";
import { ORDER_CONFIRMATION_QUESTION } from "../../src/services/order-quote.service.js";
import { createOrderConfirmationConfig } from "../../src/agents/consultation/order-confirmation.config.js";
import { createSupportTools } from "../../src/agents/consultation/support-tools.js";

export const itemArgs = { productId: "product-a", variantId: "variant-a", quantity: 1 };
export const localShipping = { recipientName: "Persona Alfa", city: "Minga Guazú", department: "Zona Alfa", street: "Referencia Alfa" };
export const readyContext = () => ({ telefonoCliente: "595900000001", carrito: evalCart({
  envio: { destinatario: localShipping.recipientName, ciudad: localShipping.city, departamento: localShipping.department, direccion: localShipping.street },
  facturacion: { requiere: false },
}) });

// Servidor de herramientas en memoria: evidencia del cliente se inyecta por el
// harness, fuera de los argumentos del modelo. No inicia agente ni servicios.
export function purchaseFixture({ fixtures = evalFixtures(), context = {}, bankConfig, orderFaults, generatePdf, sendPdf,
  confirmationConfig = createOrderConfirmationConfig({}) } = {}) {
  const clock = createClock(FIXTURE_NOW), transport = createFakeWhatsApp();
  const world = createMemoryWorld(fixtures, { clock, transport, bankConfig, orderFaults, generatePdf, sendPdf });
  world.initialize(buildInitialState(context, fixtures, { chatId: "purchase-test@lid", now: clock.now() }));
  let turn = null, sequence = 0;
  const attachments = new Map();
  const runtime = { catalog: world.catalog, transport, now: world.now, agentConfig: world.agentConfig, alerts: world.agentAlerts,
    getCart: world.getCart, orders: { listByPhone: async phone => world.orders.list().filter(order => order.userPhoneNumber === phone),
      listByChat: async chatId => world.orders.list().filter(order => order.whatsappChatId === chatId) },
    handoffs: { get: id => world.handoffs.get(id), upsert: async (id, value) => world.handoffs.set(id, { ...world.handoffs.get(id), ...value }) },
    cartRepository: world.cartRepository, quoteRepository: world.quoteRepository,
    orderRepository: world.orderRepository, bankConfig: world.bankConfig,
    getState: world.getState, setState: world.setState,
    getTurnContext: () => turn, getTurnAttachment: id => attachments.get(id) ?? null,
    uploadCustomizationImage: world.uploadCustomizationImage, getOwnProfile: world.getOwnProfile };
  const purchase = createPurchaseTools(runtime, { confirmationConfig });
  runtime.getCommittedReceipt = () => purchase.orders.receiptForTurn();
  const registry = createToolRegistry({ ...purchase.handlers, ...createSupportTools(runtime), responder: createResponder({ ...runtime, purchase }) });
  world.setToolGate(registry.check);
  for (const name of Object.keys(purchase.handlers).concat("responder", "derivar")) world.registerTool(name,
    (args, context) => registry.dispatch(name, args, context), { real: true });
  world.recordShownQuote = purchase.quotes.markShown;
  world.orderConfirmationQuestion = ORDER_CONFIRMATION_QUESTION;
  function nextTurn(text = "Consulta de prueba", media = []) {
    sequence++;
    turn = { id: "batch-" + sequence, sequence, messages: [{ text, type: "text" }] };
    attachments.clear();
    for (const entry of media) attachments.set(entry.id, { data: entry.data, mimeType: entry.mimeType });
    world.beginTurn(sequence, new AbortController().signal);
    return turn;
  }
  nextTurn();
  return { world, clock, transport, runtime, purchase, registry, nextTurn,
    call: (name, args = {}, options) => world.invokeTool(name, args, options),
    close: () => { attachments.clear(); world.close(); transport.close(); } };
}

export async function shownPurchaseFixture(options = {}, confirmation = "Sí, confirmo") {
  const fixture = purchaseFixture({ ...options, context: options.context ?? readyContext() });
  try {
    const quote = await fixture.call("cotizar");
    if (!quote.confirmable) throw new Error("El fixture no permite cotizar: " + JSON.stringify(quote.fields));
    const shown = await fixture.call("responder", { texto: "Revisá el resumen.", entendido: true, quoteIdMostrado: quote.quoteId });
    if (shown.code !== "OK") throw new Error("El fixture no pudo mostrar la cotización.");
    fixture.nextTurn(confirmation);
    return { ...fixture, quote };
  } catch (error) { fixture.close(); throw error; }
}
