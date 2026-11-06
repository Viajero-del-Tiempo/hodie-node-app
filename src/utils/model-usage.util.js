import { randomUUID } from "node:crypto";

const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "ETIMEDOUT",
  "ENETRESET", "ENETDOWN", "ENETUNREACH", "EHOSTUNREACH", "EAI_AGAIN", "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

// Datos estructurados primero. El SDK instalado pierde cause/code al envolver
// fetch; solo sus firmas concretas de transporte sirven como respaldo. Nunca
// se conserva el mensaje, la URL ni el cuerpo de la solicitud en el informe.
export function classifyModelError(error) {
  const chain = [], seen = new Set();
  for (let item = error; item && typeof item === "object" && !seen.has(item) && chain.length < 8; item = item.cause) {
    seen.add(item); chain.push(item);
  }
  const httpStatus = chain.flatMap(item => [item.status, item.statusCode, item.response?.status])
    .find(value => Number.isInteger(value) && value >= 100 && value <= 599);
  const result = (errorClass, retryable, details = {}) => ({ errorClass, retryable,
    ...(httpStatus !== undefined ? { httpStatus } : {}), ...details });
  if (error?.code === "MODEL_CALL_TIMEOUT") return result("MODEL_TIMEOUT", true);
  if (["TURN_TIMEOUT", "AGENT_TIMEOUT", "GUARDIAN_TIMEOUT"].includes(error?.code)) return result("TURN_TIMEOUT", false);
  if (["GUARDIAN_SHUTDOWN", "TURN_CLOSED", "MODEL_ATTEMPT_CLOSED"].includes(error?.code)) return result("CANCELLED", false);
  if (httpStatus === 429) return result("RATE_LIMIT", true);
  if (httpStatus >= 500) return result("PROVIDER_5XX", true);
  // Un 4xx explícito nunca se transforma en reintentable por su causa de red.
  if (httpStatus >= 400) return result("HTTP_4XX", false);
  if (chain.some(item => item.constructor?.name === "GoogleGenerativeAIRequestInputError")) return result("INVALID_REQUEST", false);
  const networkCode = chain.find(item => NETWORK_CODES.has(item.code))?.code;
  if (networkCode) return result("NETWORK", true, { networkCode });
  const sdkNetwork = chain.some(item => item.constructor?.name === "GoogleGenerativeAIError"
    && typeof item.message === "string"
    && (/^\[GoogleGenerativeAI Error\]: Error fetching from https?:\/\/\S+: (?:fetch failed|Failed to fetch|NetworkError when attempting to fetch resource\.?|network (?:error|request failed)|socket hang up|(?:read )?ECONNRESET|EPIPE|ETIMEDOUT)$/iu.test(item.message)
      || item.message === "[GoogleGenerativeAI Error]: Error reading from the stream"));
  if (sdkNetwork) return result("NETWORK", true);
  if (chain.some(item => item.name === "AbortError" || item.constructor?.name === "GoogleGenerativeAIAbortError")) return result("CANCELLED", false);
  return result("OTHER", false);
}

// Sin mensajes crudos del SDK: pueden contener solicitudes o el prompt.
export function safeErrorDetails(error) {
  const knownNames = new Set(["Error", "TypeError", "RangeError", "AbortError", "TimeoutError", "ApiError", "GoogleGenerativeAIError"]);
  const { retryable: _retryable, ...classification } = classifyModelError(error);
  return { errorName: knownNames.has(error?.name) ? error.name : "OtherError",
    ...classification };
}

// Tokens de consumo: exclusivamente metadatos del proveedor. La descomposición
// fija es una estimación separada, sin red ni almacenamiento del prompt privado.
export function estimateFixedInput({ systemPrompt, toolSchemas, serverContext }) {
  const measure = text => ({ characters: text.length, estimatedTokens: Math.ceil(text.length / 4) });
  const components = { systemPrompt: measure(systemPrompt), toolSchemas: measure(JSON.stringify(toolSchemas)),
    serverContext: measure(serverContext) };
  return { method: "characters_div_4", estimated: true, ...components,
    estimatedTokensTotal: Object.values(components).reduce((sum, item) => sum + item.estimatedTokens, 0) };
}

// Cuenta invoke(), no criterios ni herramientas. Tiempos con reloj monotónico.
export function emptyModelUsage() {
  return { instrumented: true, calls: 0, observedCalls: 0, successfulCalls: 0, failedCalls: 0,
    pendingCalls: 0, reportedTokens: { input: 0, output: 0, total: 0 }, cachedContentTokenCount: 0,
    cacheUsageReportedCalls: 0, callsWithoutUsage: 0, usageComplete: true, callDetails: [] };
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
        || ["cachedContentTokenCount", "cacheUsageReportedCalls"].some(field => usage[field] !== undefined && !valid(usage[field]))
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
    result.cachedContentTokenCount += item.cachedContentTokenCount ?? 0;
    result.cacheUsageReportedCalls += item.cacheUsageReportedCalls ?? 0;
    result.usageComplete &&= item.usageComplete === true;
    result.callDetails.push(...structuredClone(item.callDetails ?? []));
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
  for (const field of ["cachedContentTokenCount", "cacheUsageReportedCalls"]) result[field] = (after[field] ?? 0) - (before[field] ?? 0);
  result.usageComplete = result.callsWithoutUsage === 0;
  const seen = new Set((before.callDetails ?? []).map(call => call.id));
  result.callDetails = structuredClone((after.callDetails ?? []).filter(call => !seen.has(call.id)));
  return result;
}

const validToken = value => Number.isSafeInteger(value) && value >= 0;
export function modelUsageForComponent(usage, component) {
  if (!usage?.instrumented || (usage.callDetails?.length ?? 0) !== usage.observedCalls) return unknownModelUsage();
  const result = emptyModelUsage();
  result.callDetails = structuredClone(usage.callDetails.filter(call => call.component === component));
  result.calls = result.observedCalls = result.callDetails.length;
  for (const call of result.callDetails) {
    result[call.status === "success" ? "successfulCalls" : call.status === "failed" ? "failedCalls" : "pendingCalls"]++;
    for (const field of ["input", "output", "total"]) if (validToken(call.reportedTokens?.[field])) result.reportedTokens[field] += call.reportedTokens[field];
    if (!["input", "output", "total"].every(field => validToken(call.reportedTokens?.[field]))) result.callsWithoutUsage++;
    if (validToken(call.cachedContentTokenCount)) { result.cachedContentTokenCount += call.cachedContentTokenCount; result.cacheUsageReportedCalls++; }
  }
  result.usageComplete = result.callsWithoutUsage === 0;
  return result;
}
export function createModelUsageTracker({ now = () => performance.now(), component = "model" } = {}) {
  const calls = [];
  const trackerId = randomUUID();
  return {
    async invoke(action, metadata = {}) {
      const entry = { id: trackerId + ":" + (calls.length + 1), status: "pending", usage: null, startedAt: now(),
        component, turn: metadata.turn ?? null, callInTurn: metadata.callInTurn ?? null,
        attempt: metadata.attempt, modelStep: metadata.modelStep,
        fixedInput: metadata.fixedInput ? structuredClone(metadata.fixedInput) : null };
      calls.push(entry);
      try {
        const response = await action();
        entry.usage = response?.usage_metadata ?? null;
        // Ambas formas representan la misma parte de la entrada: elegir una,
        // nunca sumarlas ni agregarlas a total_tokens. Gemini puede conservarla
        // solo en response_metadata. Ausencia queda desconocida por llamada.
        entry.cached = [response?.usage_metadata?.cachedContentTokenCount,
          response?.usage_metadata?.input_token_details?.cache_read,
          response?.usageMetadata?.cachedContentTokenCount,
          response?.response_metadata?.usageMetadata?.cachedContentTokenCount,
          response?.response_metadata?.cachedContentTokenCount].find(validToken) ?? null;
        if (!entry.usage && (response?.response_metadata?.usageMetadata || response?.usageMetadata)) {
          const raw = response.response_metadata?.usageMetadata ?? response.usageMetadata;
          entry.usage = { input_tokens: raw.promptTokenCount, output_tokens: raw.candidatesTokenCount, total_tokens: raw.totalTokenCount };
        }
        entry.status = "success";
        return response;
      } catch (error) { entry.status = "failed"; entry.errorCode = error.code ?? null; entry.errorDetails = safeErrorDetails(error); throw error; }
      finally { entry.durationMs = Math.max(0, now() - entry.startedAt); }
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
        if (valid(entry.cached)) { result.cachedContentTokenCount += entry.cached; result.cacheUsageReportedCalls++; }
        if (!valid(input) || !valid(output) || !valid(total)) result.callsWithoutUsage++;
        result.callDetails.push({ id: entry.id, component: entry.component, turn: entry.turn, callInTurn: entry.callInTurn, status: entry.status,
          ...(entry.attempt !== undefined ? { attempt: entry.attempt, modelStep: entry.modelStep } : {}),
          ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
          ...(entry.errorDetails ?? {}),
          durationMs: entry.durationMs ?? Math.max(0, now() - entry.startedAt), incomplete: entry.status === "pending",
          reportedTokens: { input: valid(input) ? input : null, output: valid(output) ? output : null, total: valid(total) ? total : null },
          cachedContentTokenCount: valid(entry.cached) ? entry.cached : null,
          ...(entry.fixedInput ? { fixedInput: structuredClone(entry.fixedInput) } : {}) });
      }
      result.usageComplete = result.callsWithoutUsage === 0;
      return result;
    },
  };
}
