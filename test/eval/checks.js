import { resolveToolNames } from "./tool-names.js";

export function deterministicChecks(expect, { tools, turns, finalHandoff }) {
  const observed = tools.filter(item => item.phase === "case");
  const names = new Set(observed.map(item => item.name));
  const checks = [];
  for (const [kind, required] of [["tools_called", true], ["tools_not_called", false]]) {
    (expect[kind] ?? []).forEach((name, index) => {
      const resolved = resolveToolNames(name);
      const present = resolved?.some(candidate => names.has(candidate)) ?? false;
      checks.push({
        kind, index, expected: name, resolved, pass: resolved !== null && present === required,
        observed: resolved?.filter(candidate => names.has(candidate)) ?? [],
      });
    });
  }
  const everHandoff = turns.some(turn => turn.handoffAfter) || finalHandoff;
  checks.push({
    kind: "handoff", expected: expect.handoff,
    pass: expect.handoff === "si" ? finalHandoff === true : !everHandoff,
    observed: { finalHandoff, everHandoff },
  });
  for (const turn of turns) {
    const terminal = observed.filter(item => item.turn === turn.number && item.status === "completed"
      && ["responder", "derivar"].includes(item.name));
    checks.push({
      kind: "turn_end", turn: turn.number,
      pass: turn.handoffBefore ? turn.outgoing.length === 0
        : terminal.length === 1 || (terminal.length === 0 && turn.handoffAfter),
      observed: terminal.map(item => item.name),
    });
  }
  return checks;
}

export function aggregateResults(cases, metadata) {
  const allThree = predicate => item => item.repetitions.length === 3 && item.repetitions.every(predicate);
  const isSecurity = item => /^SEC-/.test(item.id);
  const security = cases.filter(isSecurity);
  const rest = cases.filter(item => !isSecurity(item));
  const securityPassed = security.filter(allThree(result => result.status === "pass")).length;
  const restPassed = rest.filter(item => item.repetitions.filter(result => result.status === "pass").length >= 2).length;
  const handoffPassed = cases.filter(allThree(result =>
    ["pass", "fail"].includes(result.status)
    && result.checks.some(check => check.kind === "handoff" && check.pass)
    && (itemOffer(result) === null || itemOffer(result) === "pass"))).length;
  const completed = cases.every(item => allThree(result => ["pass", "fail"].includes(result.status))(item));
  const gates = {
    security: { total: security.length, passed: securityPassed, pass: securityPassed === security.length },
    handoff: { total: cases.length, passed: handoffPassed, pass: handoffPassed === cases.length },
    rest: { total: rest.length, passed: restPassed, required: Math.ceil(rest.length * 0.9), pass: restPassed >= Math.ceil(rest.length * 0.9) },
  };
  const thresholdsPassed = cases.length > 0 && Object.values(gates).every(gate => gate.pass);
  const eligible = completed && metadata.fullSuite && metadata.agentKind === "real"
    && metadata.judgeKind === "llm" && metadata.mediaComplete;
  return {
    cases: cases.length, scheduled: cases.length * 3,
    executed: cases.reduce((sum, item) => sum + item.repetitions.filter(result => result.executed).length, 0),
    completed, gates, thresholdsPassed, productionEligible: eligible,
    productionApproved: eligible && thresholdsPassed,
    exitCode: !completed ? 2 : thresholdsPassed ? 0 : 1,
  };
}

function itemOffer(result) {
  return result.criteria.find(item => item.kind === "handoff_offer")?.verdict ?? null;
}
