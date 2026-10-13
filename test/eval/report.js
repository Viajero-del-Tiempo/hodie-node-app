import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";

export async function writeReport(report, outputRoot) {
  const id = report.metadata.startedAt.replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
  const directory = resolve(outputRoot, id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  const trace = report.cases.flatMap(item => item.repetitions.flatMap(result => [
    ...result.tools.map(event => ({ case: item.id, repetition: result.number, ...event })),
    ...result.turns.map(turn => ({
      case: item.id, repetition: result.number, type: "turn", number: turn.number,
      incoming: turn.incoming, outgoing: turn.outgoing, handoffAfter: turn.handoffAfter, durationMs: turn.durationMs,
      usage: turn.usage, agentDiagnostics: turn.agentDiagnostics, guardian: turn.guardian,
      ...(turn.timeout ? { timeout: turn.timeout } : {}),
      modelCalls: turn.modelCalls,
    })),
    ...(result.guardianEvents ?? []).map(event => ({ case: item.id, repetition: result.number, type: "guardian", ...event })),
    ...["agent", "evaluator"].flatMap(owner => (result.modelUsage[owner].callDetails ?? []).map(call =>
      ({ case: item.id, repetition: result.number, type: "model_call", owner, ...call }))),
  ]));
  await writeFile(join(directory, "trace.jsonl"), trace.map(event => JSON.stringify(event)).join("\n") + "\n", { flag: "wx" });
  const lines = [
    "# Evaluación del agente", "",
    "Modo: " + report.metadata.agentKind + " / " + report.metadata.judgeKind + ".",
    "Corrida completa: " + report.summary.completed + ".",
    "Diagnóstico sin evaluación de calidad: " + report.summary.diagnostic + ".",
    "Criterios no evaluados: " + report.summary.criteriaNotEvaluated + ".",
    "Código de salida: " + report.summary.exitCode + ".",
    "Aprobación de producción: " + report.summary.productionApproved + ".", "",
    "## Modelo y pensamiento del agente", "",
    ...report.metadata.agentConfigurations.map(config => "- Modelo: " + (config.model ?? "desconocido")
      + "; pensamiento enviado: " + JSON.stringify(config.thinking)
      + (config.requestedThinking ? "; solicitado para el modelo inyectado (sin afirmar aplicación): " + JSON.stringify(config.requestedThinking) : "")),
    "",
    "## Consumo del modelo", "",
    ...Object.entries(report.summary.modelUsage).map(([name, usage]) =>
      "- " + name + ": llamadas " + (usage.calls ?? "desconocidas")
      + "; tokens informados (entrada/salida/total): " + usage.reportedTokens.input + "/" + usage.reportedTokens.output + "/" + usage.reportedTokens.total
      + "; instrumentado: " + usage.instrumented + "; consumo completo: " + usage.usageComplete
      + "; llamadas sin metadatos: " + usage.callsWithoutUsage),
    "",
    "## Latencia (ms)", "",
    "Percentiles por rango más próximo; incluye fallos y tiempo observado de llamadas interrumpidas.", "",
    "| Medición | Muestras | Incompletas | p50 | p95 | Máximo |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...Object.entries({ ...report.summary.latency.models, tools: report.summary.latency.tools.overall, turns: report.summary.latency.turns,
      ...Object.fromEntries(Object.entries(report.summary.latency.tools.byName).map(([name, stats]) => ["tool: " + name, stats])) })
      .map(([name, stats]) => "| " + name + " | " + stats.samples + " | " + stats.incompleteSamples + " | "
        + [stats.p50Ms, stats.p95Ms, stats.maxMs].map(value => value === null ? "sin muestras" : value.toFixed(1)).join(" | ") + " |"),
    "", "## Llamadas al modelo por turno", "",
    "Agente incluye consulta y transcripción; el evaluador se mide aparte. Incluye turnos silenciosos con cero llamadas conocidas y turnos interrumpidos.", "",
    "| Componente | Turnos medidos | Desconocidos | p50 | p95 | Máximo |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...Object.entries(report.summary.modelCallsPerTurn).map(([name, stats]) => "| " + name + " | " + stats.samples + " | " + stats.unknownSamples
      + " | " + [stats.p50, stats.p95, stats.max].map(value => value ?? "sin muestras").join(" | ") + " |"),
    "", "## Latencia por posición de llamada en el turno (ms)", "",
    "| Componente | Llamada en turno | Muestras | Incompletas | p50 | p95 | Máximo |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...Object.entries(report.summary.latency.byCallInTurn).flatMap(([name, group]) => Object.entries(group.byPosition)
      .map(([position, stats]) => "| " + name + " | " + position + " | " + stats.samples + " | " + stats.incompleteSamples
        + " | " + [stats.p50Ms, stats.p95Ms, stats.maxMs].map(value => value === null ? "sin muestras" : value.toFixed(1)).join(" | ") + " |")),
    ...Object.entries(report.summary.latency.byCallInTurn).filter(([_name, group]) => group.unindexedCalls)
      .map(([name, group]) => "- " + name + ": " + group.unindexedCalls + " llamadas sin posición informada."),
    "", "## Entrada fija por llamada del agente", "",
    "Estimación local (caracteres/4), no tokens facturados de Gemini. El proveedor informa solo la entrada total.",
    "No incluye historial, mensajes del cliente, resultados de herramientas, multimedia ni formato interno del proveedor.",
    "El informe guarda cantidades, nunca el prompt ni los esquemas privados.", "",
    ...["systemPrompt", "toolSchemas", "serverContext"].map(key => "- " + key + ": media estimada "
      + (report.summary.fixedInput[key].estimatedTokensMean?.toFixed(1) ?? "sin muestras") + " tokens por llamada; total estimado "
      + report.summary.fixedInput[key].estimatedTokensTotal + "; caracteres " + report.summary.fixedInput[key].charactersTotal + "."),
    "",
    "## Umbrales", "",
    ...Object.entries(report.summary.gates).map(([name, gate]) =>
      "- " + name + ": " + gate.passed + "/" + gate.total + "; cumple: " + gate.pass
      + "; evaluado: " + gate.evaluated
      + (gate.required !== undefined ? "; mínimo: " + gate.required : "")),
    "", "## Casos", "",
  ];
  for (const item of report.cases) {
    lines.push("### " + item.id + " · " + item.category, "");
    for (const result of item.repetitions) {
      lines.push("- Ejecución " + result.number + ": " + result.status + ".");
      for (const check of result.checks.filter(check => !check.pass)) lines.push("  - Verificación fallida: " + JSON.stringify(check));
      for (const criterion of result.criteria.filter(criterion => criterion.verdict !== "pass")) {
        lines.push("  - " + criterion.kind + ": " + criterion.text + " — "
          + (criterion.verdict === "not_evaluated" ? "no evaluado" : criterion.verdict) + ": " + criterion.explanation);
      }
      for (const diagnostic of result.diagnostics) {
        lines.push("  - " + diagnostic.code + ": " + diagnostic.message
          + (diagnostic.line ? " (" + diagnostic.file + ":" + diagnostic.line + ")" : ""));
        if (diagnostic.interruptedPhase) lines.push("    - Fase interrumpida: " + JSON.stringify(diagnostic.interruptedPhase));
      }
    }
    lines.push("");
  }
  await writeFile(join(directory, "summary.md"), lines.join("\n") + "\n", { flag: "wx" });
  return directory;
}
