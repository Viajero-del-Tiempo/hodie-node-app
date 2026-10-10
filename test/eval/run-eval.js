import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { loadCases, validationSummary } from "./load-cases.js";
import { buildInitialState, prepareShownQuote } from "./initial-state.js";
import { createMemoryWorld, createClock } from "./memory-world.js";
import { createFakeWhatsApp } from "./fake-whatsapp.js";
import { assertAgent, withTimeout } from "./agent-contract.js";
import { deterministicChecks, aggregateResults } from "./checks.js";
import { createStubJudge, createLLMJudge } from "./judge.js";
import { checkToolSpecification } from "./tool-names.js";
import { writeReport } from "./report.js";
import { enableMemoryOnly } from "./production-guard.js";
import { emptyModelUsage, readModelUsage, sumModelUsage, modelUsageSince } from "../../src/utils/model-usage.util.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const errorDiagnostic = (error, location = {}) => ({
  code: error.code ?? "EVALUATION_ERROR", message: error.message,
  ...(typeof error.rawExcerpt === "string" ? { rawExcerpt: error.rawExcerpt.slice(0, 300) } : {}),
  ...location,
});

async function runRepetition(item, fixtures, options, number) {
  const result = {
    number, status: "blocked", executed: false, agentKind: null,
    checks: [], criteria: [], tools: [], turns: [], diagnostics: structuredClone(item.diagnostics),
    before: null, after: null,
    modelUsage: { agent: emptyModelUsage(), evaluator: emptyModelUsage() },
  };
  if (item.diagnostics.length) return result;
  const evaluatorBefore = readModelUsage(options.judge, { knownZero: options.judge.kind === "stub" });
  const clock = createClock(options.now);
  const transport = createFakeWhatsApp({ mediaResolver: options.mediaResolver });
  const world = createMemoryWorld(fixtures, { clock, transport });
  let agent;
  let initialized = false;
  let factoryStarted = false;
  try {
    const initial = buildInitialState(item.input.context ?? {}, fixtures, {
      chatId: "eval-" + randomUUID() + "@lid", now: clock.now(),
    });
    world.initialize(initial);
    initialized = true;
    factoryStarted = true;
    agent = assertAgent(await withTimeout(signal => options.createAgent({ world, transport, signal }), options.timeoutMs, "AGENT_SETUP_TIMEOUT"));
    result.agentKind = agent.kind;
    result.agentModelInjected = agent.metadata?.modelInjected === true;
    try {
      await withTimeout(signal => prepareShownQuote(item.input.context, world, signal), options.timeoutMs, "QUOTE_SETUP_TIMEOUT");
    } catch (error) {
      result.diagnostics.push(errorDiagnostic(error, item.contextLocation()));
      return result;
    }
    result.before = world.snapshot();
    const identity = { userPhoneNumber: initial.state.userPhoneNumber, phoneVerified: initial.state.phoneVerified };
    const conversation = world.getHistory().map(message => ({ ...message, turn: 0 }));
    result.executed = true;
    for (const [index, input] of item.input.turns.entries()) {
      const number = index + 1;
      const turn = await transport.receive(input, number, item.id);
      const handoffBefore = world.getState().humanHandoffRequired;
      const startedAt = performance.now();
      const incoming = turn.messages.map(message => ({
        role: "user", turn: number, content: message.text,
        ...(message.attachmentId ? { attachment: turn.attachments.find(attachment => attachment.id === message.attachmentId) } : {}),
      }));
      conversation.push(...incoming);
      let failure = null;
      let usage = null;
      let agentDiagnostics = [];
      let guardian = null;
      try {
        await withTimeout(async signal => {
          world.beginTurn(number, signal);
          const response = await agent.runTurn({
            turn, history: world.getHistory(), now: clock.now(),
            scenario: {
              newSession: number === 1 && world.scenario.newSession,
              previousSession: number === 1 ? structuredClone(world.scenario.previousSession) : null,
            }, signal,
          });
          usage = response?.usage ?? null;
          agentDiagnostics = response?.diagnostics ?? [];
          guardian = response?.guardian ?? null;
          for (const [index, message] of (response?.processedMessages ?? []).entries()) {
            if (incoming[index]) incoming[index].content = message.text;
          }
        }, options.timeoutMs);
      } catch (error) { failure = error; }
      finally { transport.endTurn(); }
      const outgoing = transport.getOutgoing().filter(message => message.turn === number);
      const sent = outgoing.map(message => ({
        role: "assistant", turn: number, eventId: message.id,
        content: message.type === "text" ? message.text
          : (message.caption ? message.caption + " " : "") + "[imagen enviada: " + message.source + "]",
      }));
      conversation.push(...sent);
      const state = world.getState();
      // El runner administra el historial simulado. Nunca persiste bytes/attachmentId.
      state.messages.push(...[...incoming, ...sent].map(message => ({ role: message.role, content: message.content })));
      state.lastActivityAt = clock.now();
      world.setState(state);
      result.turns.push({
        number, incoming, outgoing, handoffBefore, handoffAfter: state.humanHandoffRequired,
        durationMs: performance.now() - startedAt, usage, agentDiagnostics, guardian, snapshotAfter: world.snapshot(),
      });
      if (failure) throw failure;
      clock.advance(1000);
    }
    result.after = world.snapshot();
    result.tools = world.getEvents();
    result.guardianEvents = world.getGuardianEvents();
    result.checks = deterministicChecks(item.input.expect, {
      tools: result.tools, turns: result.turns, finalHandoff: world.getState().humanHandoffRequired,
    });
    const requests = ["must", "must_not"].flatMap(kind =>
      (item.input.expect[kind] ?? []).map((text, index) => ({
        kind, text, index, location: item.criterionLocation(kind, index),
      })));
    if (item.input.expect.handoff === "ofrece") requests.push({
      kind: "handoff_offer", text: "Ofrece atención humana sin afirmar que el chat ya fue derivado.",
      index: 0, location: { file: options.filename, ...item.location },
    });
    let judgeError = false;
    let unobservable = false;
    for (const request of requests) {
      try {
        const judgment = await options.judge.evaluate({
          criterion: request, conversation, tools: result.tools,
          referenceData: result.before, before: result.before, after: result.after, identity,
          turnSnapshots: result.turns.map(turn => ({ turn: turn.number, snapshot: turn.snapshotAfter })),
        });
        const verdicts = options.judge.kind === "stub" ? ["not_evaluated"] : ["pass", "fail", "not_observable"];
        if (!verdicts.includes(judgment?.verdict)) {
          throw Object.assign(new Error("Veredicto desconocido"), { code: "INVALID_JUDGE_RESPONSE" });
        }
        result.criteria.push({ ...request, ...judgment });
        unobservable ||= judgment.verdict === "not_observable";
      } catch (error) {
        judgeError = true;
        result.criteria.push({ ...request, verdict: "error", explanation: error.message, evidence: [] });
        result.diagnostics.push(errorDiagnostic(error, request.location));
      }
    }
    result.status = judgeError ? "error" : unobservable ? "blocked"
      : !result.checks.every(check => check.pass) ? "fail"
      : options.judge.kind === "stub" ? "not_evaluated"
      : result.criteria.every(criterion => criterion.verdict === "pass") ? "pass" : "fail";
    return result;
  } catch (error) {
    result.status = "error";
    result.diagnostics.push(errorDiagnostic(error));
    return result;
  } finally {
    if (initialized) result.after = world.snapshot();
    result.tools = world.getEvents();
    result.guardianEvents = world.getGuardianEvents();
    // Cerrar primero evita envíos/escrituras tardías tras cancelación.
    world.close();
    if (agent?.dispose) {
      try { await withTimeout(signal => agent.dispose({ signal }), Math.min(options.timeoutMs, 5000), "DISPOSE_TIMEOUT"); }
      catch (error) { result.status = "error"; result.diagnostics.push(errorDiagnostic(error)); }
    }
    result.modelUsage.agent = factoryStarted ? readModelUsage(agent, { knownZero: agent?.kind === "trivial" }) : emptyModelUsage();
    result.modelUsage.evaluator = modelUsageSince(evaluatorBefore, readModelUsage(options.judge, { knownZero: options.judge.kind === "stub" }));
  }
}

export async function runEvaluation(dataset, {
  createAgent, judge, timeoutMs = 60000, now = Date.now(), caseIds = [], categories = [],
  mediaResolver = null, onRepetition = () => {},
} = {}) {
  enableMemoryOnly();
  if (dataset.errors.length || dataset.warnings.length) {
    throw Object.assign(new Error("El archivo no es válido"), { code: "INVALID_FILE", diagnostics: [...dataset.errors, ...dataset.warnings] });
  }
  if (typeof createAgent !== "function" || typeof judge?.evaluate !== "function") throw new Error("Falta agente o evaluador");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Timeout inválido");
  for (const id of caseIds) if (!dataset.cases.some(item => item.id === id)) throw new Error("Caso inexistente: " + id);
  for (const category of categories) if (!dataset.cases.some(item => item.category === category)) throw new Error("Categoría inexistente: " + category);
  const selected = dataset.cases.filter(item => (!caseIds.length || caseIds.includes(item.id)) && (!categories.length || categories.includes(item.category)));
  if (!selected.length) throw new Error("La selección no contiene casos");
  const metadata = {
    startedAt: new Date().toISOString(), fixtureTime: new Date(now).toISOString(),
    timezone: "America/Asuncion", filename: dataset.filename, fixtureHash: dataset.hash,
    fileVersion: dataset.version, repetitions: 3, fullSuite: selected.length === dataset.cases.length,
    totalInFile: dataset.cases.length, categories: dataset.categories,
    node: process.version, agentKind: null, judgeKind: judge.kind, judge: judge.metadata ?? { kind: judge.kind },
    mediaComplete: true,
  };
  const options = { createAgent, judge, timeoutMs, now, mediaResolver, filename: dataset.filename };
  const judgeUsageBefore = readModelUsage(judge, { knownZero: judge.kind === "stub" });
  const cases = [];
  for (const item of selected) {
    const repetitions = [];
    for (let number = 1; number <= 3; number++) {
      const result = await runRepetition(item, dataset.fixtures, options, number);
      repetitions.push(result);
      await onRepetition({ case: item.id, repetition: number, status: result.status, diagnostics: result.diagnostics });
    }
    cases.push({ id: item.id, category: item.category, source: item.input?.source ?? null, location: item.location, repetitions });
  }
  const kinds = [...new Set(cases.flatMap(item => item.repetitions.map(result => result.agentKind).filter(Boolean)))];
  metadata.agentKind = kinds.length === 1 ? kinds[0] : kinds.length ? "mixed" : "unknown";
  metadata.agentModelInjected = cases.some(item => item.repetitions.some(result => result.agentModelInjected));
  metadata.judgeModelInjected = judge.metadata?.modelInjected === true;
  // Un caso con imágenes no ejecutado tampoco certifica cobertura visual.
  metadata.mediaComplete = selected.every((item, index) => {
    if (!Array.isArray(item.input?.turns)) return false;
    return item.input.turns.every((turn, turnIndex) => {
      if (turn === null || typeof turn !== "object") return false;
      if (turn.attachment !== "image") return true;
      return cases[index].repetitions.every(result => {
        const frame = result.turns[turnIndex];
        return frame?.incoming.some(message => {
          if (message.attachment?.mode !== "file") return false;
          if (!frame.guardian) return true;
          return frame.guardian.outcome === "processed"
            && frame.guardian.imageAttachmentIds?.includes(message.attachment.id);
        });
      });
    });
  });
  metadata.finishedAt = new Date().toISOString();
  const summary = aggregateResults(cases, metadata);
  summary.modelUsage = {
    agent: sumModelUsage(cases.flatMap(item => item.repetitions.map(result => result.modelUsage.agent))),
    evaluator: modelUsageSince(judgeUsageBefore, readModelUsage(judge, { knownZero: judge.kind === "stub" })),
  };
  return { metadata, summary, cases };
}

async function loadAgent(name) {
  const url = name === "trivial" ? new URL("./agents/trivial-agent.js", import.meta.url)
    : name === "real" ? new URL("../../src/agents/consultation/eval-adapter.js", import.meta.url) : pathToFileURL(resolve(name));
  const module = await import(url.href);
  if (typeof module.createAgent !== "function") throw new Error("El módulo debe exportar createAgent");
  return { factory: module.createAgent, module: url.href };
}

export function parseCaseSelection({ case: individual = [], cases: lists = [] } = {}) {
  const ids = [...individual];
  for (const list of lists) {
    const parts = list.split(",").map(id => id.trim());
    if (parts.some(id => !id)) throw new Error("--cases contiene un ID vacío");
    ids.push(...parts);
  }
  return [...new Set(ids)];
}

async function loadMediaResolver(filename, dataset) {
  if (!filename) return null;
  const absolute = resolve(filename);
  const manifest = JSON.parse(await readFile(absolute, "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("El manifiesto de imágenes debe ser un objeto");
  for (const [key, value] of Object.entries(manifest)) {
    const matching = dataset.cases.some(item => item.input?.turns?.some((turn, index) => turn.attachment === "image" && key === item.id + "/" + (index + 1)));
    if (!matching || !value || typeof value.path !== "string" || !/^image\/(png|jpeg|webp|gif)$/.test(value.mimeType)
        || Object.keys(value).some(field => !["path", "mimeType"].includes(field))) {
      throw new Error("Referencia de imagen inválida: " + key);
    }
  }
  return async ({ caseId, turn }) => {
    const media = manifest[caseId + "/" + turn];
    if (!media) return null;
    return { data: await readFile(resolve(dirname(absolute), media.path)), mimeType: media.mimeType };
  };
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args, options: {
      validate: { type: "boolean", default: false }, help: { type: "boolean", default: false },
      file: { type: "string", default: resolve(HERE, "conversations.yaml") },
      agent: { type: "string", default: "trivial" }, judge: { type: "string", default: "stub" },
      case: { type: "string", multiple: true }, cases: { type: "string", multiple: true }, category: { type: "string", multiple: true },
      output: { type: "string", default: resolve(HERE, "results") }, media: { type: "string" },
      now: { type: "string" }, "timeout-ms": { type: "string", default: "60000" },
      "judge-timeout-ms": { type: "string", default: "60000" },
    }, strict: true, allowPositionals: false,
  });
  if (values.help) {
    console.log("npm run test:eval -- [--validate] [--agent trivial|real|ruta] [--judge stub|llm] [--case ID] [--cases ID,ID] [--category nombre] [--media manifiesto.json] [--now ISO] [--output directorio]");
    return 0;
  }
  enableMemoryOnly();
  const dataset = await loadCases(resolve(values.file));
  const spec = checkToolSpecification(await readFile(resolve(HERE, "../../docs/SPEC-agente.md"), "utf8"));
  if (!spec.valid) dataset.errors.push({
    code: "TOOL_SPEC_MISMATCH", file: "docs/SPEC-agente.md",
    message: "Registro desalineado: " + JSON.stringify(spec),
  });
  if (values.validate || dataset.errors.length || dataset.warnings.length) {
    console.log(JSON.stringify(validationSummary(dataset), null, 2));
    return dataset.errors.length || dataset.warnings.length || dataset.cases.some(item => item.diagnostics.length) ? 2 : 0;
  }
  if (!["stub", "llm"].includes(values.judge)) throw new Error("Evaluador desconocido");
  const caseIds = parseCaseSelection(values);
  // Validar la selección antes de crear clientes que podrían usar la red.
  for (const id of caseIds) if (!dataset.cases.some(item => item.id === id)) throw new Error("Caso inexistente: " + id);
  for (const category of values.category ?? []) if (!dataset.cases.some(item => item.category === category)) throw new Error("Categoría inexistente: " + category);
  if (!dataset.cases.some(item => (!caseIds.length || caseIds.includes(item.id))
      && (!values.category?.length || values.category.includes(item.category)))) throw new Error("La selección no contiene casos");
  const timeoutMs = Number(values["timeout-ms"]);
  const judgeTimeoutMs = Number(values["judge-timeout-ms"]);
  if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs) || !(judgeTimeoutMs > 0) || !Number.isFinite(judgeTimeoutMs)) throw new Error("Timeout inválido");
  const now = values.now === undefined ? Date.now() : Date.parse(values.now);
  if (!Number.isFinite(now)) throw new Error("Fecha inicial inválida");
  if (values.judge === "llm" || values.agent !== "trivial") {
    // Agente/evaluador reales usan Gemini; no se inicia ningún servicio productivo.
    const dotenv = await import("dotenv");
    dotenv.config({ quiet: true });
  }
  const adapter = await loadAgent(values.agent);
  const judge = values.judge === "stub" ? createStubJudge() : await createLLMJudge({ timeoutMs: judgeTimeoutMs });
  const report = await runEvaluation(dataset, {
    createAgent: adapter.factory, judge, timeoutMs, now,
    caseIds, categories: values.category ?? [],
    mediaResolver: await loadMediaResolver(values.media, dataset),
    onRepetition: result => console.log(JSON.stringify(result)),
  });
  report.metadata.agentModule = adapter.module;
  const directory = await writeReport(report, values.output);
  console.log(JSON.stringify({ directory, ...report.summary }, null, 2));
  return report.summary.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) {
    console.error(JSON.stringify({ ...errorDiagnostic(error), diagnostics: error.diagnostics ?? [] }, null, 2));
    process.exitCode = 2;
  }
}
