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
    })),
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
      }
    }
    lines.push("");
  }
  await writeFile(join(directory, "summary.md"), lines.join("\n") + "\n", { flag: "wx" });
  return directory;
}
