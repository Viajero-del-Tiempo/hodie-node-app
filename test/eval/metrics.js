// Estadísticas descriptivas: no participan en checks, umbrales ni veredictos.
export function latencyStats(samples) {
  const values = samples.map(item => typeof item === "number" ? item : item.durationMs)
    .filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const percentile = fraction => values.length ? values[Math.ceil(values.length * fraction) - 1] : null;
  return { samples: values.length, incompleteSamples: samples.filter(item => item?.incomplete === true).length,
    p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: values.at(-1) ?? null };
}

export function countStats(samples) {
  const values = samples.filter(value => Number.isSafeInteger(value) && value >= 0).sort((a, b) => a - b);
  const percentile = fraction => values.length ? values[Math.ceil(values.length * fraction) - 1] : null;
  return { samples: values.length, unknownSamples: samples.length - values.length,
    p50: percentile(0.5), p95: percentile(0.95), max: values.at(-1) ?? null };
}

export function turnModelCalls(usage, turn) {
  const details = usage?.callDetails ?? [];
  const indexed = usage?.instrumented === true && details.length === usage.observedCalls
    && details.every(call => Number.isSafeInteger(call.turn) && call.turn > 0);
  if (!indexed) return { agent: turn.usage?.instrumented === true ? turn.usage.calls : null,
    consultation: null, transcription: null };
  const calls = details.filter(call => call.turn === turn.number);
  const classified = calls.every(call => ["agent", "transcription"].includes(call.component));
  return { agent: calls.length,
    consultation: classified ? calls.filter(call => call.component === "agent").length : null,
    transcription: classified ? calls.filter(call => call.component === "transcription").length : null };
}

export function evaluationMetrics(cases) {
  const runs = cases.flatMap(item => item.repetitions);
  const modelCalls = owner => runs.flatMap(run => run.modelUsage[owner].callDetails ?? []);
  const agent = modelCalls("agent"), evaluator = modelCalls("evaluator");
  const tools = runs.flatMap(run => run.tools), turns = runs.flatMap(run => run.turns);
  const turnCalls = runs.flatMap(run => run.turns.map(turn => turnModelCalls(run.modelUsage.agent, turn)));
  const byCallInTurn = component => {
    const calls = agent.filter(call => call.component === component);
    const indexed = calls.filter(call => Number.isSafeInteger(call.callInTurn) && call.callInTurn > 0);
    return { unindexedCalls: calls.length - indexed.length,
      byPosition: Object.fromEntries([...new Set(indexed.map(call => call.callInTurn))].sort((a, b) => a - b)
        .map(position => [position, latencyStats(indexed.filter(call => call.callInTurn === position))])) };
  };
  const byName = Object.fromEntries([...new Set(tools.map(tool => tool.name))].sort()
    .map(name => [name, latencyStats(tools.filter(tool => tool.name === name))]));
  const fixedCalls = agent.filter(call => call.fixedInput);
  const fixedInput = { callsWithBreakdown: fixedCalls.length, method: "characters_div_4", estimated: true,
    excludes: ["history", "client_input", "tool_results", "multimedia", "provider_framing"] };
  for (const key of ["systemPrompt", "toolSchemas", "serverContext"]) {
    const estimates = fixedCalls.map(call => call.fixedInput[key].estimatedTokens);
    fixedInput[key] = { estimatedTokensTotal: estimates.reduce((sum, value) => sum + value, 0),
      estimatedTokensMean: estimates.length ? estimates.reduce((sum, value) => sum + value, 0) / estimates.length : null,
      charactersTotal: fixedCalls.reduce((sum, call) => sum + call.fixedInput[key].characters, 0) };
  }
  return { latency: { models: { agent: latencyStats(agent), evaluator: latencyStats(evaluator),
    consultation: latencyStats(agent.filter(call => call.component === "agent")),
    transcription: latencyStats(agent.filter(call => call.component === "transcription")) },
    tools: { overall: latencyStats(tools), byName },
    byCallInTurn: { consultation: byCallInTurn("agent"), transcription: byCallInTurn("transcription") },
    turns: latencyStats(turns.map(turn => ({ durationMs: turn.durationMs, incomplete: Boolean(turn.timeout) }))) },
    modelCallsPerTurn: Object.fromEntries(["agent", "consultation", "transcription"].map(component =>
      [component, countStats(turnCalls.map(call => call[component]))])), fixedInput };
}
