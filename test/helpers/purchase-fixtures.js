import { createMemoryWorld, createClock } from "../eval/memory-world.js";
import { createFakeWhatsApp } from "../eval/fake-whatsapp.js";
import { buildInitialState } from "../eval/initial-state.js";
import { createPurchaseTools } from "../../src/agents/consultation/purchase-tools.js";
import { createResponder } from "../../src/agents/consultation/terminal.js";
import { createToolRegistry } from "../../src/agents/consultation/tool-registry.js";
import { evalFixtures, evalCart } from "./eval-fixtures.js";
import { FIXTURE_NOW } from "./consultation-fixtures.js";

export const itemArgs = { productId: "product-a", variantId: "variant-a", quantity: 1 };
export const localShipping = { recipientName: "Persona Alfa", city: "Minga Guazú", department: "Zona Alfa", street: "Referencia Alfa" };
export const readyContext = () => ({ telefonoCliente: "595900000001", carrito: evalCart({
  envio: { destinatario: localShipping.recipientName, ciudad: localShipping.city, departamento: localShipping.department, direccion: localShipping.street },
  facturacion: { requiere: false },
}) });

// Servidor de herramientas en memoria: evidencia del cliente se inyecta por el
// harness, fuera de los argumentos del modelo. No inicia agente ni servicios.
export function purchaseFixture({ fixtures = evalFixtures(), context = {} } = {}) {
  const clock = createClock(FIXTURE_NOW), transport = createFakeWhatsApp();
  const world = createMemoryWorld(fixtures, { clock, transport });
  world.initialize(buildInitialState(context, fixtures, { chatId: "purchase-test@lid", now: clock.now() }));
  let turn = null, sequence = 0;
  const attachments = new Map();
  const runtime = { catalog: world.catalog, transport, now: world.now,
    cartRepository: world.cartRepository, quoteRepository: world.quoteRepository,
    getState: world.getState, setState: world.setState,
    getTurnContext: () => turn, getTurnAttachment: id => attachments.get(id) ?? null,
    uploadCustomizationImage: world.uploadCustomizationImage, getOwnProfile: world.getOwnProfile };
  const purchase = createPurchaseTools(runtime);
  const registry = createToolRegistry({ ...purchase.handlers, responder: createResponder({ ...runtime, purchase }) });
  world.setToolGate(registry.check);
  for (const name of Object.keys(purchase.handlers).concat("responder")) world.registerTool(name,
    (args, context) => registry.dispatch(name, args, context), { real: true });
  world.recordShownQuote = purchase.quotes.markShown;
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
