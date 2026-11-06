import { assertCheckpointState } from "./attachments.js";
// Puerto para el grafo nuevo. El llamador inyecta un grafo/checkpointer aislado;
// no importa SDKs ni usa el grafo productivo. No compartir colecciones de prueba
// con el saver actual: su consulta de namespace está limitada a 25 snapshots.
export function createCheckpointStateStore({ graph, threadId, namespace, asNode }) {
  if (!graph?.getState || !graph?.updateState || !threadId || !namespace || !asNode) throw new Error("Puerto de checkpoint incompleto");
  const config = { configurable: { thread_id: threadId, checkpoint_ns: namespace } };
  return {
    async read() {
      const snapshot = await graph.getState(config);
      return snapshot?.values ? structuredClone(assertCheckpointState(snapshot.values)) : null;
    },
    async write(state) { await graph.updateState(config, structuredClone(assertCheckpointState(state)), asNode); },
  };
}
