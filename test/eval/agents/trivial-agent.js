// Prueba del runner: no conoce casos, expectativas, productos ni políticas.
export async function createAgent({ world }) {
  return {
    kind: "trivial",
    async runTurn() {
      if (world.getState().humanHandoffRequired) return;
      await world.invokeTool("responder", { texto: "Recibí tu mensaje.", entendido: true });
    },
  };
}
