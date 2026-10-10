import { createConsultationAgent } from "./agent.js";
import { createReadTools } from "./read-tools.js";
import { createResponder } from "./terminal.js";
import { createToolRegistry } from "./tool-registry.js";
import { normalizePurchasePhone } from "./order-access.js";
import { createGuardianConfig } from "../guardian/config.js";
import { createGuardianRuntime } from "../guardian/runtime.js";

// Adaptador exclusivo del runner. Ningún import de Firestore, WhatsApp o grafo
// productivo: toda lectura y todo envío provienen del mundo de esta repetición.
export async function createAgent({ world, transport, signal, model = null, prompt = null, timeoutMs,
  audioModel = null, guardianConfig = createGuardianConfig(process.env) }) {
  signal?.throwIfAborted();
  let turnSignal = null;
  const runtime = {
    catalog: world.catalog, transport,
    getState: world.getState, setState: world.setState, getCart: world.getCart,
    handoffs: { updateLastMessage: (id, values) => world.handoffs.set(id, { ...world.handoffs.get(id), ...values }) },
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
  const registry = createToolRegistry({ ...createReadTools(runtime), responder: createResponder(runtime) });
  // El gate se ejecuta dentro del interceptor: registra también los intentos
  // inválidos, sin invocar handlers existentes fuera de la lista permitida.
  world.setToolGate(registry.check);
  for (const name of registry.names) {
    world.registerTool(name, (args, context) => registry.dispatch(name, args, { ...context, signal: turnSignal ?? context.signal }), { real: true });
  }
  const agent = await createConsultationAgent({ runtime, registry, model, prompt,
    timeoutMs: timeoutMs ?? guardianConfig.turnTimeoutMs });
  const guardian = createGuardianRuntime({ runtime, agent, audioModel, config: guardianConfig,
    clock: world.clock, logger: world.recordGuardianEvent });
  signal?.throwIfAborted();
  let firstTurn = true;
  return { kind: agent.kind, metadata: guardian.metadata, getModelUsage: guardian.getModelUsage,
    runTurn: input => {
      const scenario = input.scenario ?? { newSession: firstTurn && world.scenario.newSession };
      firstTurn = false;
      return guardian.runDeclaredTurn({ ...input, scenario });
    }, dispose: () => guardian.shutdown() };
}
