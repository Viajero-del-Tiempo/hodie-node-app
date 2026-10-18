import { createAgentRuntime } from "./runtime-factory.js";
import { normalizePurchasePhone } from "./order-access.js";
import { createGuardianConfig } from "../guardian/config.js";
import { ORDER_CONFIRMATION_QUESTION } from "../../services/order-quote.service.js";

// Adaptador exclusivo del runner. Ningún import de Firestore, WhatsApp o grafo
// productivo: toda lectura y todo envío provienen del mundo de esta repetición.
export async function createAgent({ world, transport, signal, model = null, prompt = null, timeoutMs,
  audioModel = null, guardianConfig = createGuardianConfig(process.env), thinkingBudget,
  modelEnv = process.env, modelFactory, modelCallTimeoutMs, modelClock, confirmationConfig }) {
  signal?.throwIfAborted();
  const ports = {
    catalog: world.catalog, transport, agentConfig: world.agentConfig, alerts: world.agentAlerts,
    getState: world.getState, setState: world.setState, getCart: world.getCart,
    now: world.now, cartRepository: world.cartRepository, quoteRepository: world.quoteRepository,
    orderRepository: world.orderRepository, bankConfig: world.bankConfig,
    receiptRepository: world.receiptRepository, receiptStorage: world.receiptStorage,
    uploadCustomizationImage: world.uploadCustomizationImage, getOwnProfile: world.getOwnProfile,
    setExecutionPhase: world.setExecutionPhase, getExecutionPhase: world.getExecutionPhase,
    recordImageEvent: world.recordGuardianEvent,
    handoffs: {
      get: id => world.handoffs.get(id),
      upsert: (id, values) => world.handoffs.set(id, { fecha: world.now(), ...world.handoffs.get(id), ...values }),
      updateLastMessage: (id, values) => world.handoffs.set(id, { ...world.handoffs.get(id), ...values }),
    },
    invokeTool: (name, args) => world.invokeTool(name, args),
    orders: {
      async getByNumber(number) { return world.orders.get(number); },
      async listByChat(chatId) { return world.orders.list().filter(order => order.whatsappChatId === chatId); },
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
  world.orderConfirmationQuestion = ORDER_CONFIRMATION_QUESTION;
  const { agent, guardian } = await createAgentRuntime({ ports, model, prompt, thinkingBudget, modelEnv, modelFactory,
    timeoutMs, guardianConfig, modelCallTimeoutMs, modelClock, audioModel, clock: world.clock,
    logger: world.recordGuardianEvent, confirmationConfig,
    onPurchase: purchase => { world.recordShownQuote = (quote, turn, context) => purchase.quotes.markShown(quote, turn, context); },
    installTools(registry, dispatch) {
      // También registra argumentos inválidos dentro del interceptor del runner.
      world.setToolGate(registry.check);
      for (const name of registry.names) world.registerTool(name, (args, context) => dispatch(name, args, context), { real: true });
    },
  });
  signal?.throwIfAborted();
  let firstTurn = true;
  return { kind: agent.kind, metadata: guardian.metadata, getModelUsage: guardian.getModelUsage,
    runTurn: input => {
      const scenario = input.scenario ?? { newSession: firstTurn && world.scenario.newSession };
      firstTurn = false;
      return guardian.runDeclaredTurn({ ...input, scenario });
    }, dispose: () => guardian.shutdown() };
}
