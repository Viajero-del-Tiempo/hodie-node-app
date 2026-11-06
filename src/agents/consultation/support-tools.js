import { activateAgentHandoff } from "../../services/agent-handoff.service.js";

export function createSupportTools(runtime) {
  return { async derivar({ motivo, texto }, { signal } = {}) {
    signal?.throwIfAborted();
    // El cierre de un commit de este turno conserva el pago exclusivo del
    // servidor. Una derivación no puede reemplazarlo por texto del modelo.
    if (await runtime.getCommittedReceipt?.()) return { code: "CIERRE_PEDIDO_REQUERIDO", field: "texto",
      message: "El pedido ya se registró en este turno. Cerrá con responder para entregar las instrucciones de pago del servidor." };
    signal?.throwIfAborted();
    return activateAgentHandoff(runtime, { motivo, texto, signal });
  } };
}
