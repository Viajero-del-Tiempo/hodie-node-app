import { AIMessage } from "@langchain/core/messages";
import { randomUUID } from "node:crypto";
import { createMemoryWorld, createClock } from "../eval/memory-world.js";
import { createFakeWhatsApp } from "../eval/fake-whatsapp.js";
import { buildInitialState } from "../eval/initial-state.js";
import { evalFixtures } from "./eval-fixtures.js";
import { createAgent } from "../../src/agents/consultation/eval-adapter.js";
import { enableMemoryOnly } from "../eval/production-guard.js";

export const FIXTURE_NOW = Date.parse("2026-01-01T12:00:00Z");
export function reply(name, args, id = randomUUID()) {
  return new AIMessage({ content: "", tool_calls: [{ id, name, args, type: "tool_call" }],
    usage_metadata: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } });
}
export function scriptedModel(steps) {
  const invocations = [];
  const bindings = [];
  return {
    model: "test-model", invocations, bindings,
    bindTools(definitions, options) {
      bindings.push({ definitions, options });
      return { async invoke(messages, config) {
        const index = invocations.length;
        invocations.push({ messages: [...messages], config });
        if (index >= steps.length) throw new Error("No hay respuesta de prueba para esta invocación.");
        return typeof steps[index] === "function" ? steps[index](messages, config) : steps[index];
      } };
    },
  };
}
export async function consultationFixture({ fixtures = evalFixtures(), context = {}, model = scriptedModel([]), timeoutMs } = {}) {
  enableMemoryOnly();
  const clock = createClock(FIXTURE_NOW);
  const transport = createFakeWhatsApp();
  const world = createMemoryWorld(fixtures, { clock, transport });
  world.initialize(buildInitialState(context, fixtures, { chatId: "test-customer@lid", now: clock.now() }));
  const agent = await createAgent({ world, transport, model, timeoutMs });
  return { world, transport, agent, model,
    async run(input = { user: "Consulta de prueba" }, number = 1, signal = new AbortController().signal) {
      const turn = await transport.receive(input, number, "TEST-CONSULTATION");
      world.beginTurn(number, signal);
      try { return await agent.runTurn({ turn, history: world.getHistory(), now: clock.now(), signal }); }
      finally { transport.endTurn(); }
    },
    close: () => world.close(),
  };
}
