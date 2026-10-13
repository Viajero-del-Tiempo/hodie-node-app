import { createConsultationAgent } from "./agent.js";
import { createReadTools } from "./read-tools.js";
import { createResponder } from "./terminal.js";
import { createToolRegistry } from "./tool-registry.js";
import { normalizePurchasePhone } from "./order-access.js";
import { createGuardianConfig } from "../guardian/config.js";
import { createGuardianRuntime } from "../guardian/runtime.js";
import { createPurchaseTools } from "./purchase-tools.js";
import { ORDER_CONFIRMATION_QUESTION } from "../../services/order-quote.service.js";

// Adaptador exclusivo del runner. Ningún import de Firestore, WhatsApp o grafo
// productivo: toda lectura y todo envío provienen del mundo de esta repetición.
export async function createAgent({ world, transport, signal, model = null, prompt = null, timeoutMs,
  audioModel = null, guardianConfig = createGuardianConfig(process.env), thinkingBudget,
  modelEnv = process.env, modelFactory, modelCallTimeoutMs, modelClock, confirmationConfig }) {
  signal?.throwIfAborted();
  let turnSignal = null;
  let currentTurn = null;
  let turnAttachments = null;
  const runtime = {
    catalog: world.catalog, transport,
    getState: world.getState, setState: world.setState, getCart: world.getCart,
    now: world.now, cartRepository: world.cartRepository, quoteRepository: world.quoteRepository,
    orderRepository: world.orderRepository, bankConfig: world.bankConfig,
    uploadCustomizationImage: world.uploadCustomizationImage, getOwnProfile: world.getOwnProfile,
    setExecutionPhase: world.setExecutionPhase, getExecutionPhase: world.getExecutionPhase,
    getTurnContext: () => currentTurn,
    setTurnContext: value => { currentTurn = value; },
    setTurnAttachments: value => { turnAttachments = value; },
    getTurnAttachment: id => turnAttachments?.get(id) ?? null,
    handoffs: {
      upsert: (id, values) => world.handoffs.set(id, { fecha: world.now(), ...world.handoffs.get(id), ...values }),
      updateLastMessage: (id, values) => world.handoffs.set(id, { ...world.handoffs.get(id), ...values }),
    },
    invokeTool: (name, args) => world.invokeTool(name, args),
    setTurnSignal: value => { turnSignal = value; },
    orders: {
      async getByNumber(number) { return world.orders.get(number); },
      async listByPhone(phone) {
        const timestamp = order => {
          const value = order.createdAt;
          if (value instanceof Date) return value.getTime();
          if (typeof value === "string") return Date.parse(value);
          if (Number.isFinite(value?.seconds)) return value.seconds * 1000;
          return NaN;
        };
        return world.orders.list().filter(order => normalizePurchasePhone(order.userPhoneNumber) === phone)
          .sort((a, b) => {
            const left = timestamp(a), right = timestamp(b);
            return Number.isFinite(left) && Number.isFinite(right) ? right - left : 0;
          });
      },
    },
  };
  const purchase = createPurchaseTools(runtime, { confirmationConfig });
  runtime.getCommittedReceipt = () => purchase.orders.receiptForTurn();
  runtime.getCart = () => purchase.carts.read();
  world.orderConfirmationQuestion = ORDER_CONFIRMATION_QUESTION;
  world.recordShownQuote = (quote, turn, context) => purchase.quotes.markShown(quote, turn, context);
  const registry = createToolRegistry({ ...createReadTools(runtime), ...purchase.handlers,
    responder: createResponder({ ...runtime, purchase }) });
  // El gate se ejecuta dentro del interceptor: registra también los intentos
  // inválidos, sin invocar handlers existentes fuera de la lista permitida.
  world.setToolGate(registry.check);
  for (const name of registry.names) {
    world.registerTool(name, (args, context) => registry.dispatch(name, args, { ...context, signal: turnSignal ?? context.signal }), { real: true });
  }
  const agent = await createConsultationAgent({ runtime, registry, model, prompt, thinkingBudget, modelEnv, modelFactory,
    timeoutMs: timeoutMs ?? guardianConfig.turnTimeoutMs, modelCallTimeoutMs, modelClock });
  const guardian = createGuardianRuntime({ runtime, agent, audioModel, config: guardianConfig,
    clock: world.clock, logger: world.recordGuardianEvent, deadlineClock: modelClock });
  signal?.throwIfAborted();
  let firstTurn = true;
  return { kind: agent.kind, metadata: guardian.metadata, getModelUsage: guardian.getModelUsage,
    runTurn: input => {
      const scenario = input.scenario ?? { newSession: firstTurn && world.scenario.newSession };
      firstTurn = false;
      return guardian.runDeclaredTurn({ ...input, scenario });
    }, dispose: () => guardian.shutdown() };
}
