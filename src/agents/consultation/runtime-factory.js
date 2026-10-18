import { createConsultationAgent } from "./agent.js";
import { createReadTools } from "./read-tools.js";
import { createResponder } from "./terminal.js";
import { createToolRegistry } from "./tool-registry.js";
import { createGuardianConfig } from "../guardian/config.js";
import { createGuardianRuntime } from "../guardian/runtime.js";
import { createPurchaseTools } from "./purchase-tools.js";
import { createSupportTools } from "./support-tools.js";
import { createReceiptTools } from "./receipt-tools.js";

// Composición única para runner y piloto. No importa Firebase ni WhatsApp.
export async function createAgentRuntime({ ports, installTools, onPurchase = () => {}, model = null, prompt = null,
  audioModel = null, guardianConfig = createGuardianConfig(process.env), clock, logger, timeoutMs,
  thinkingBudget, modelEnv = process.env, modelFactory, modelCallTimeoutMs, modelClock, confirmationConfig }) {
  let turnSignal = null, currentTurn = null, turnAttachments = null;
  let registry;
  const runtime = { ...ports,
    getTurnContext: () => currentTurn,
    setTurnContext: value => { currentTurn = value; },
    setTurnAttachments: value => { turnAttachments = value; },
    getTurnAttachment: id => turnAttachments?.get(id) ?? null,
    setTurnSignal: value => { turnSignal = value; },
    invokeTool: ports.invokeTool ?? ((name, args) => registry.dispatch(name, args, { signal: turnSignal })),
  };
  const purchase = createPurchaseTools(runtime, { confirmationConfig });
  runtime.getCommittedReceipt = () => purchase.orders.receiptForTurn();
  runtime.getCart = () => purchase.carts.read();
  onPurchase(purchase);
  registry = createToolRegistry({ ...createReadTools(runtime), ...purchase.handlers, ...createSupportTools(runtime),
    ...createReceiptTools(runtime), responder: createResponder({ ...runtime, purchase }) });
  installTools?.(registry, (name, args, context = {}) => registry.dispatch(name, args, { ...context, signal: turnSignal ?? context.signal }));
  const agent = await createConsultationAgent({ runtime, registry, model, prompt, thinkingBudget, modelEnv, modelFactory,
    timeoutMs: timeoutMs ?? guardianConfig.turnTimeoutMs, modelCallTimeoutMs, modelClock });
  const guardian = createGuardianRuntime({ runtime, agent, audioModel, config: guardianConfig,
    clock, logger, deadlineClock: modelClock });
  return { runtime, registry, purchase, agent, guardian };
}
