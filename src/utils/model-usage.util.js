// Cuenta invoke(), no criterios ni herramientas. Tokens: solo metadatos del proveedor.
export function emptyModelUsage() {
  return { instrumented: true, calls: 0, observedCalls: 0, successfulCalls: 0, failedCalls: 0,
    pendingCalls: 0, reportedTokens: { input: 0, output: 0, total: 0 }, callsWithoutUsage: 0, usageComplete: true };
}
export function unknownModelUsage() {
  return { ...emptyModelUsage(), instrumented: false, calls: null, usageComplete: false };
}

export function readModelUsage(source, { knownZero = false } = {}) {
  if (typeof source?.getModelUsage !== "function") return knownZero ? emptyModelUsage() : unknownModelUsage();
  try {
    const usage = source.getModelUsage();
    const valid = value => Number.isSafeInteger(value) && value >= 0;
    if (usage?.instrumented !== true
        || !["calls", "observedCalls", "successfulCalls", "failedCalls", "pendingCalls", "callsWithoutUsage"].every(field => valid(usage[field]))
        || !["input", "output", "total"].every(field => valid(usage.reportedTokens?.[field]))
        || usage.calls !== usage.observedCalls
        || usage.successfulCalls + usage.failedCalls + usage.pendingCalls !== usage.calls) return unknownModelUsage();
    return sumModelUsage([usage]);
  } catch { return unknownModelUsage(); }
}

export function sumModelUsage(values) {
  const result = emptyModelUsage();
  for (const value of values) {
    const item = value ?? unknownModelUsage();
    result.instrumented &&= item.instrumented === true;
    for (const field of ["observedCalls", "successfulCalls", "failedCalls", "pendingCalls", "callsWithoutUsage"]) result[field] += item[field] ?? 0;
    for (const field of ["input", "output", "total"]) result.reportedTokens[field] += item.reportedTokens?.[field] ?? 0;
    result.usageComplete &&= item.usageComplete === true;
  }
  result.calls = result.instrumented ? result.observedCalls : null;
  return result;
}

export function modelUsageSince(before, after) {
  if (!before?.instrumented || !after?.instrumented) return unknownModelUsage();
  const result = emptyModelUsage();
  for (const field of ["calls", "observedCalls", "successfulCalls", "failedCalls", "pendingCalls", "callsWithoutUsage"]) {
    result[field] = after[field] - before[field];
  }
  for (const field of ["input", "output", "total"]) result.reportedTokens[field] = after.reportedTokens[field] - before.reportedTokens[field];
  result.usageComplete = result.callsWithoutUsage === 0;
  return result;
}

export function createModelUsageTracker() {
  const calls = [];
  return {
    async invoke(action) {
      const entry = { status: "pending", usage: null };
      calls.push(entry);
      try {
        const response = await action();
        entry.usage = response?.usage_metadata ?? null;
        entry.status = "success";
        return response;
      } catch (error) { entry.status = "failed"; throw error; }
    },
    snapshot() {
      const result = emptyModelUsage();
      result.calls = result.observedCalls = calls.length;
      const valid = value => Number.isSafeInteger(value) && value >= 0;
      for (const entry of calls) {
        result[entry.status === "success" ? "successfulCalls" : entry.status === "failed" ? "failedCalls" : "pendingCalls"]++;
        const input = entry.usage?.input_tokens;
        const output = entry.usage?.output_tokens;
        const total = entry.usage?.total_tokens;
        if (valid(input)) result.reportedTokens.input += input;
        if (valid(output)) result.reportedTokens.output += output;
        if (valid(total)) result.reportedTokens.total += total;
        if (!valid(input) || !valid(output) || !valid(total)) result.callsWithoutUsage++;
      }
      result.usageComplete = result.callsWithoutUsage === 0;
      return result;
    },
  };
}
