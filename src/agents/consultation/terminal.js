export function createResponder({ getState, setState, transport }) {
  return async ({ texto, entendido }, { signal } = {}) => {
    signal?.throwIfAborted();
    await transport.sendText(texto);
    signal?.throwIfAborted();
    const state = getState();
    state.consecutiveMisunderstandings = entendido ? 0 : (state.consecutiveMisunderstandings ?? 0) + 1;
    // La escalada y derivar como herramienta se implementan en la entrega 5.
    setState(state);
    return { code: "OK", entendido };
  };
}

export async function forceTechnicalHandoff({ getState, setState, transport }, reason, { signal } = {}) {
  signal?.throwIfAborted();
  const state = getState();
  if (state.humanHandoffRequired) return;
  state.humanHandoffRequired = true;
  state.humanHandoffReason = reason;
  setState(state);
  // Cierre mínimo por código: sin herramienta del modelo, índice ni alerta externa.
  await transport.sendText("No pude continuar con la consulta. Una persona del equipo te va a responder por este chat.");
}
