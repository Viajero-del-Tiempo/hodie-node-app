import { createGuardianConfig } from "../../src/agents/guardian/config.js";
import { createGuardianRuntime } from "../../src/agents/guardian/runtime.js";
import { createModelUsageTracker } from "../../src/utils/model-usage.util.js";
import { createVirtualClock } from "./virtual-clock.js";

export function guardianFixture({ overrides = {}, state: initial = {}, clock = createVirtualClock(100000),
  step = null, audioModel = null, processEvents = null } = {}) {
  let state = { messages: [], whatsappChatId: "test-guardian@lid", sessionCutoff: 0, lastActivityAt: null,
    consecutiveMisunderstandings: 0, humanHandoffRequired: false, humanHandoffReason: null,
    userPhoneNumber: null, phoneVerified: false, lastQuote: null, ...structuredClone(initial) };
  const outgoing = [], incoming = [], logs = [], downloads = [], handoffs = [];
  const attachments = new Map();
  const tracker = createModelUsageTracker();
  const runtime = {
    getState: () => structuredClone(state), setState: next => { state = structuredClone(next); },
    transport: {
      sendText: async text => { outgoing.push(text); },
      getAttachment: id => { downloads.push(id); return attachments.get(id) ?? null; },
    },
    handoffs: { async updateLastMessage(id, value) { handoffs.push({ id, ...value }); } },
  };
  const agent = { metadata: { modelInjected: true }, getModelUsage: () => tracker.snapshot(),
    async runTurn(input) {
      incoming.push(input);
      await tracker.invoke(async () => {
        if (step) await step(input, runtime);
        else await runtime.transport.sendText("Respuesta de prueba.");
        return { usage_metadata: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } };
      });
      return { diagnostics: [] };
    },
  };
  const config = createGuardianConfig({}, overrides);
  const guardian = createGuardianRuntime({ runtime, agent, clock, config, audioModel, processEvents, logger: value => logs.push(value) });
  return { runtime, guardian, agent, clock, config, outgoing, incoming, logs, downloads, handoffs, attachments,
    state: () => runtime.getState(),
    turn: (messages = [{ text: "Mensaje de prueba", type: "chat" }], media = []) => ({ turn: 1, messages, attachments: media }),
    run: input => guardian.processTurn({ turn: input ?? { turn: 1, messages: [{ text: "Mensaje de prueba", type: "chat" }], attachments: [] } }),
  };
}
