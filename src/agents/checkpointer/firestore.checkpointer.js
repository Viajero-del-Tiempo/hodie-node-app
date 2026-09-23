import { BaseCheckpointSaver, copyCheckpoint } from "@langchain/langgraph";
import { db } from "../../config/firebase.js";

const WRITES_IDX_MAP = {
  __error__: -1,
  __interrupt__: -2,
  __resume__: -3,
};

/**
 * Checkpointer personalizado para LangGraph que persiste hilos conversacionales en Google Cloud Firestore.
 * Permite que el estado conversacional de cada usuario de WhatsApp sobreviva reinicios del servidor.
 *
 * [DEUDA TÉCNICA CONSCIENTE V1 - POLÍTICA DE RETENCIÓN]:
 * En esta versión 1, cada paso de la conversación persiste un nuevo checkpoint en la subcolección
 * 'langgraph_checkpoints/{thread_id}/checkpoints'. No se aplica borrado automático de snapshots históricos.
 * Para entornos de producción de alto volumen a largo plazo, se contempla para V2 implementar:
 * 1. Poda de snapshots antiguos en 'put' conservando los últimos N checkpoints por hilo (ej. N = 30).
 * 2. O un job programado (TTL) que depure registros con más de 30/60 días de antigüedad.
 *
 * [NOTA DE ARQUITECTURA - FILTRADO DE NAMESPACE EN MEMORIA]:
 * El filtrado por 'checkpoint_ns' ocurre en memoria para evitar requerir índices compuestos en Firestore.
 * Si en el futuro se incorporan subgrafos concurrentes en el mismo thread y se consultara con 'limit',
 * el filtrado post-consulta podría devolver menos resultados que el límite solicitado. En V1 esto no
 * impacta dado que el sistema opera con un único namespace principal.
 */
export class FirestoreCheckpointSaver extends BaseCheckpointSaver {
  /**
   * @param {import("firebase-admin").firestore.Firestore} [firestoreDb]
   * @param {any} [serde]
   */
  constructor(firestoreDb, serde) {
    super(serde);
    this.db = firestoreDb || db;
    this.checkpointsCollection = "langgraph_checkpoints";
    this.writesCollection = "langgraph_checkpoint_writes";
  }

  /**
   * Genera clave unificada para búsquedas de escrituras
   * @private
   */
  _generateKey(threadId, checkpointNamespace, checkpointId) {
    return `${threadId}__${checkpointNamespace || "default"}__${checkpointId}`;
  }

  /**
   * Recupera un CheckpointTuple según la configuración suministrada
   * @param {import("@langchain/core/runnables").RunnableConfig} config
   */
  async getTuple(config) {
    const threadId = config.configurable?.thread_id;
    const checkpointNamespace = config.configurable?.checkpoint_ns ?? "";
    let checkpointId = config.configurable?.checkpoint_id;

    if (!threadId) {
      return undefined;
    }

    try {
      const threadRef = this.db.collection(this.checkpointsCollection).doc(threadId);
      const checkpointsSubcol = threadRef.collection("checkpoints");

      let docSnap;
      if (checkpointId) {
        docSnap = await checkpointsSubcol.doc(checkpointId).get();
        // Bug 3: Validar que el documento exista y pertenezca al checkpointNamespace solicitado
        if (!docSnap.exists || (docSnap.data().checkpoint_ns ?? "") !== checkpointNamespace) {
          return undefined;
        }
      } else {
        // Bug 4.2: En lugar de combinar .where("checkpoint_ns", "==") con .orderBy("checkpoint_id", "desc"),
        // lo cual requeriría un índice compuesto manual en Firestore, consultamos ordenado por
        // checkpoint_id (índice simple automático) y filtramos por namespace en memoria.
        const snapshot = await checkpointsSubcol
          .orderBy("checkpoint_id", "desc")
          .limit(25)
          .get();

        const matchDoc = snapshot.docs.find(
          (doc) => (doc.data().checkpoint_ns ?? "") === checkpointNamespace
        );

        if (matchDoc) {
          docSnap = matchDoc;
          checkpointId = docSnap.id;
        }
      }

      if (!docSnap || !docSnap.exists) {
        return undefined;
      }

      const data = docSnap.data();
      const [typeCheckpoint, serializedCheckpoint] = data.checkpoint;
      const [typeMetadata, serializedMetadata] = data.metadata;
      const parentCheckpointId = data.parent_checkpoint_id;

      const deserializedCheckpoint = await this.serde.loadsTyped(
        typeCheckpoint || "json",
        serializedCheckpoint
      );
      const deserializedMetadata = await this.serde.loadsTyped(
        typeMetadata || "json",
        serializedMetadata
      );

      // Cargar escrituras pendientes asociadas
      const outerKey = this._generateKey(threadId, checkpointNamespace, checkpointId);
      const writesSnapshot = await this.db
        .collection(this.writesCollection)
        .where("outer_key", "==", outerKey)
        .get();

      const pendingWrites = await Promise.all(
        writesSnapshot.docs.map(async (wDoc) => {
          const wData = wDoc.data();
          const [valType, valSerialized] = wData.value;
          const deserializedVal = await this.serde.loadsTyped(valType || "json", valSerialized);
          return [wData.task_id, wData.channel, deserializedVal];
        })
      );

      /** @type {import("@langchain/langgraph").CheckpointTuple} */
      const checkpointTuple = {
        config: {
          configurable: {
            thread_id: threadId,
            checkpoint_id: checkpointId,
            checkpoint_ns: checkpointNamespace,
          },
        },
        checkpoint: deserializedCheckpoint,
        metadata: deserializedMetadata,
        pendingWrites,
      };

      if (parentCheckpointId) {
        checkpointTuple.parentConfig = {
          configurable: {
            thread_id: threadId,
            checkpoint_ns: checkpointNamespace,
            checkpoint_id: parentCheckpointId,
          },
        };
      }

      return checkpointTuple;
    } catch (err) {
      console.error(`❌ Error en FirestoreCheckpointSaver.getTuple para thread ${threadId}:`, err);
      return undefined;
    }
  }

  /**
   * Persiste un checkpoint en Firestore
   * @param {import("@langchain/core/runnables").RunnableConfig} config
   * @param {import("@langchain/langgraph").Checkpoint} checkpoint
   * @param {import("@langchain/langgraph").CheckpointMetadata} metadata
   */
  async put(config, checkpoint, metadata) {
    const threadId = config.configurable?.thread_id;
    const checkpointNamespace = config.configurable?.checkpoint_ns ?? "";
    const parentCheckpointId = config.configurable?.checkpoint_id;

    if (!threadId) {
      throw new Error('Configurable "thread_id" es requerido para guardar checkpoints en Firestore.');
    }

    const preparedCheckpoint = copyCheckpoint(checkpoint);

    const [serializedCheckpoint, serializedMetadata] = await Promise.all([
      this.serde.dumpsTyped(preparedCheckpoint),
      this.serde.dumpsTyped(metadata),
    ]);

    const docRef = this.db
      .collection(this.checkpointsCollection)
      .doc(threadId)
      .collection("checkpoints")
      .doc(checkpoint.id);

    await docRef.set({
      thread_id: threadId,
      checkpoint_ns: checkpointNamespace,
      checkpoint_id: checkpoint.id,
      parent_checkpoint_id: parentCheckpointId || null,
      checkpoint: serializedCheckpoint,
      metadata: serializedMetadata,
      saved_at: new Date(),
    });

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNamespace,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  /**
   * Persiste escrituras intermedias pendientes (writes).
   * Contempla el límite estricto de 500 operaciones de Firestore particionando en lotes de 400.
   * @param {import("@langchain/core/runnables").RunnableConfig} config
   * @param {Array<[string, any]>} writes
   * @param {string} taskId
   */
  async putWrites(config, writes, taskId) {
    const threadId = config.configurable?.thread_id;
    const checkpointNamespace = config.configurable?.checkpoint_ns ?? "";
    const checkpointId = config.configurable?.checkpoint_id;

    if (!threadId || !checkpointId) {
      throw new Error("thread_id y checkpoint_id son requeridos en putWrites");
    }

    const outerKey = this._generateKey(threadId, checkpointNamespace, checkpointId);

    // Firestore limita cada WriteBatch a un máximo de 500 operaciones.
    // Particionamos en bloques de 400 operaciones para garantizar seguridad total ante grafos complejos.
    const BATCH_SIZE = 400;

    for (let i = 0; i < writes.length; i += BATCH_SIZE) {
      const chunk = writes.slice(i, i + BATCH_SIZE);
      const batch = this.db.batch();

      await Promise.all(
        chunk.map(async ([channel, value], chunkIdx) => {
          const globalIdx = i + chunkIdx;
          const serializedValue = await this.serde.dumpsTyped(value);
          const innerKeyIdx = WRITES_IDX_MAP[channel] ?? globalIdx;
          const innerKeyStr = `${taskId},${innerKeyIdx}`;
          const docId = `${outerKey}__${innerKeyStr}`;

          const docRef = this.db.collection(this.writesCollection).doc(docId);
          batch.set(
            docRef,
            {
              outer_key: outerKey,
              thread_id: threadId,
              checkpoint_ns: checkpointNamespace,
              checkpoint_id: checkpointId,
              task_id: taskId,
              channel,
              value: serializedValue,
              inner_key: innerKeyStr,
              saved_at: new Date(),
            },
            { merge: true }
          );
        })
      );

      await batch.commit();
    }
  }

  /**
   * Lista el histórico de checkpoints con soporte para paginación (options.before) y límite.
   * Evita requerir índices compuestos en Firestore al consultar únicamente por checkpoint_id
   * y realizar el filtrado por namespace en memoria.
   *
   * @param {import("@langchain/core/runnables").RunnableConfig} config
   * @param {import("@langchain/langgraph").CheckpointListOptions} [options]
   */
  async *list(config, options) {
    const threadId = config.configurable?.thread_id;
    const checkpointNamespace = config.configurable?.checkpoint_ns ?? "";
    const beforeCheckpointId = options?.before?.configurable?.checkpoint_id;
    const limit = options?.limit;

    if (!threadId) return;

    // Consulta ordenada únicamente por checkpoint_id con filtro opcional de paginación 'before'.
    // Al operar sobre un solo campo (checkpoint_id), Firestore utiliza su índice simple automático
    // sin requerir ningún índice compuesto en la base de datos.
    let query = this.db
      .collection(this.checkpointsCollection)
      .doc(threadId)
      .collection("checkpoints")
      .orderBy("checkpoint_id", "desc");

    if (beforeCheckpointId) {
      query = query.where("checkpoint_id", "<", beforeCheckpointId);
    }

    const snapshot = await query.get();
    let yieldedCount = 0;

    for (const doc of snapshot.docs) {
      const data = doc.data();

      // Filtrado en memoria de namespace para aislamiento seguro
      if (checkpointNamespace !== undefined && (data.checkpoint_ns ?? "") !== checkpointNamespace) {
        continue;
      }

      const [typeCheckpoint, serializedCheckpoint] = data.checkpoint;
      const [typeMetadata, serializedMetadata] = data.metadata;

      const deserializedCheckpoint = await this.serde.loadsTyped(
        typeCheckpoint || "json",
        serializedCheckpoint
      );
      const deserializedMetadata = await this.serde.loadsTyped(
        typeMetadata || "json",
        serializedMetadata
      );

      // Cargar escrituras pendientes asociadas si existen
      const outerKey = this._generateKey(threadId, data.checkpoint_ns ?? "", data.checkpoint_id);
      const writesSnapshot = await this.db
        .collection(this.writesCollection)
        .where("outer_key", "==", outerKey)
        .get();

      const pendingWrites = await Promise.all(
        writesSnapshot.docs.map(async (wDoc) => {
          const wData = wDoc.data();
          const [valType, valSerialized] = wData.value;
          const deserializedVal = await this.serde.loadsTyped(valType || "json", valSerialized);
          return [wData.task_id, wData.channel, deserializedVal];
        })
      );

      yield {
        config: {
          configurable: {
            thread_id: threadId,
            checkpoint_ns: data.checkpoint_ns,
            checkpoint_id: data.checkpoint_id,
          },
        },
        checkpoint: deserializedCheckpoint,
        metadata: deserializedMetadata,
        pendingWrites,
        parentConfig: data.parent_checkpoint_id
          ? {
              configurable: {
                thread_id: threadId,
                checkpoint_ns: data.checkpoint_ns,
                checkpoint_id: data.parent_checkpoint_id,
              },
            }
          : undefined,
      };

      yieldedCount++;
      if (limit !== undefined && yieldedCount >= limit) {
        break;
      }
    }
  }
}
