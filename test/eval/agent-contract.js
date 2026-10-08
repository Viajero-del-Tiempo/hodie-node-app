export function assertAgent(agent) {
  if (!agent || typeof agent.runTurn !== "function" || !["trivial", "real"].includes(agent.kind)) {
    throw new Error("El adaptador debe devolver { kind: trivial|real, runTurn, dispose? }");
  }
  return agent;
}

export async function withTimeout(action, milliseconds, code = "TURN_TIMEOUT") {
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = Object.assign(new Error("Tiempo máximo excedido"), { code });
      controller.abort(error);
      reject(error);
    }, milliseconds);
  });
  try { return await Promise.race([Promise.resolve().then(() => action(controller.signal)), expired]); }
  finally { clearTimeout(timer); }
}
