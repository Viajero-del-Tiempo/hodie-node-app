import { Annotation, StateGraph, END } from "@langchain/langgraph";
import { assertCheckpointState } from "../guardian/attachments.js";
import { applyChatControl, controlError } from "../../services/agent-chat-control.service.js";

export const AGENT_CHECKPOINT_COLLECTIONS = Object.freeze({ checkpointsCollection: "agent_checkpoints", writesCollection: "agent_checkpoint_writes" });

// Guardar un snapshot no ejecuta al agente ni repite efectos. El mismo saver,
// con colecciones propias y lectura estricta, conserva el thread_id real.
export async function createAgentCheckpointStore({ db, chatId, saver, graph: suppliedGraph }) {
  let graph = suppliedGraph;
  if (!graph) {
    if (!saver) {
      const { FirestoreCheckpointSaver } = await import("../checkpointer/firestore.checkpointer.js");
      saver = new FirestoreCheckpointSaver(db, undefined, { ...AGENT_CHECKPOINT_COLLECTIONS, throwOnReadError: true });
    }
    const schema = Annotation.Root({ snapshot: Annotation({ reducer: (_old, next) => next }) });
    graph = new StateGraph(schema).addNode("checkpoint", state => state)
      .addEdge("__start__", "checkpoint").addEdge("checkpoint", END).compile({ checkpointer: saver });
  }
  const config = { configurable: { thread_id: chatId } };
  return {
    async read() {
      const result = await graph.getState(config);
      const state = result?.values?.snapshot;
      return state === undefined ? null : structuredClone(assertCheckpointState(state));
    },
    async write(state) { await graph.updateState(config, { snapshot: structuredClone(assertCheckpointState(state)) }, "checkpoint"); },
  };
}

// El snapshot actual se guarda en el documento raíz de agent_checkpoints.
// Los checkpoints históricos de 7A se leen para migrar y no se eliminan.
// Snapshot y versión del bloqueo se comprueban en la misma transacción.
export async function createControlledCheckpointStore({ db, chatId, control, fallback }) {
  let expectedVersion = (await control.get(chatId)).version;
  const ref = db.collection("agent_checkpoints").doc(chatId);
  return {
    rebase(version) { expectedVersion = version; },
    async read() {
      const current = await control.get(chatId);
      if (!current || current.version !== expectedVersion) throw controlError();
      const doc = await ref.get();
      const snapshot = doc.data()?.snapshot ?? await fallback.read();
      return snapshot ? applyChatControl(assertCheckpointState(snapshot), current) : null;
    },
    async write(state) {
      const version = expectedVersion, snapshot = structuredClone(assertCheckpointState(state));
      await db.runTransaction(async tx => {
        const current = await tx.get(control.ref(chatId));
        if (!current.exists || current.data().version !== version) throw controlError();
        tx.set(ref, { snapshot: applyChatControl(snapshot, current.data()), controlVersion: version });
      });
    },
  };
}
