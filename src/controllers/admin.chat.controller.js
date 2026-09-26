import { compiledGraph } from "../agents/graph.js";
import { db } from "../config/firebase.js";
import { runInThreadQueue } from "../config/whatsapp.js";

/**
 * Consulta la lista de hilos que están actualmente en handoff humano
 * leyendo directamente la colección índice 'handoff_threads' en Firestore.
 *
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
export const getHandoffChats = async (req, res) => {
  try {
    const snapshot = await db
      .collection("handoff_threads")
      .orderBy("fecha", "desc")
      .get();

    const chats = snapshot.docs.map((doc) => {
      const data = doc.data() || {};
      const rawFecha = data.fecha;
      let fechaIso = new Date().toISOString();

      if (rawFecha && typeof rawFecha.toDate === "function") {
        fechaIso = rawFecha.toDate().toISOString();
      } else if (rawFecha) {
        fechaIso = new Date(rawFecha).toISOString();
      }

      return {
        thread_id: data.thread_id || doc.id,
        whatsappChatId: data.whatsappChatId || (doc.id.includes("@") ? doc.id : `${doc.id}@c.us`),
        userPhoneNumber: data.userPhoneNumber || (doc.id.includes("@") ? "" : doc.id),
        motivo: data.motivo || "Atención humana requerida",
        fecha: fechaIso,
        lastCustomerMessage: data.lastCustomerMessage || "",
      };
    });

    // Ordenamiento defensivo en memoria por fecha descendente
    chats.sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime());

    return res.json({
      success: true,
      count: chats.length,
      chats,
    });
  } catch (error) {
    console.error("❌ Error en getHandoffChats:", error);
    return res.status(500).json({ error: "Error al consultar conversaciones en atención humana." });
  }
};

/**
 * Reactiva el bot para un hilo en handoff humano:
 * - Valida existencia del hilo mediante presencia de checkpoint_id en config.
 * - Valida que el hilo se encuentre efectivamente en handoff (400 si no lo está).
 * - Ejecuta updateState con asNode "human_handoff_node" dentro de runInThreadQueue.
 * - Elimina el documento del índice 'handoff_threads'.
 * - Loguea el administrador, hilo y timestamp.
 * - No despacha ningún mensaje automático al cliente.
 *
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
export const resumeBot = async (req, res) => {
  try {
    const { threadId } = req.params;
    if (!threadId) {
      return res.status(400).json({ error: "Se requiere 'threadId' en la ruta." });
    }

    const handoffRef = db.collection("handoff_threads").doc(threadId);
    const handoffDoc = await handoffRef.get();
    const handoffData = handoffDoc.exists ? handoffDoc.data() : null;

    // 1. Obtener estado actual del hilo en LangGraph
    const config = { configurable: { thread_id: threadId } };
    const state = await compiledGraph.getState(config);

    // 2. Comprobación 404: detectada estrictamente por la presencia de checkpoint_id en la config
    const hasCheckpoint = Boolean(state.config?.configurable?.checkpoint_id);
    if (!hasCheckpoint) {
      // Si figura residualmente en el índice, limpiarlo
      if (handoffDoc.exists) {
        await handoffRef.delete();
      }
      return res.status(404).json({ error: "Hilo de conversación no encontrado." });
    }

    // 3. Comprobación 400: verificar que el hilo esté en handoff
    if (!state.values?.humanHandoffRequired) {
      // Limpiar índice si quedó desfasado
      if (handoffDoc.exists) {
        await handoffRef.delete();
      }
      return res.status(400).json({ error: "El hilo de conversación no se encuentra en atención humana." });
    }

    // 4. Clave de cola para serializar y evitar colisiones concurrentes con mensajes en tránsito
    const queueKey =
      handoffData?.whatsappChatId ||
      state.values?.whatsappChatId ||
      (threadId.includes("@") ? threadId : `${threadId}@c.us`);

    // 5. Ejecutar la reactivación dentro de la cola del hilo
    await runInThreadQueue(queueKey, async () => {
      // Re-verificar estado dentro de la cola para garantizar atomicidad ante mensajes entrantes
      const currentState = await compiledGraph.getState(config);
      if (!currentState.config?.configurable?.checkpoint_id) {
        throw { statusCode: 404, message: "Hilo de conversación no encontrado." };
      }
      if (!currentState.values?.humanHandoffRequired) {
        if (handoffDoc.exists) await handoffRef.delete();
        throw { statusCode: 400, message: "El hilo de conversación no se encuentra en atención humana." };
      }

      // 6. Actualizar estado conversacional con asNode "human_handoff_node"
      await compiledGraph.updateState(
        config,
        {
          humanHandoffRequired: false,
          humanHandoffReason: null,
          activeAgent: null,
          intent: null,
        },
        "human_handoff_node"
      );

      // 7. Borrar del índice 'handoff_threads'
      await handoffRef.delete();
    });

    // 8. Registro formal en logs de auditoría
    const adminIdentifier =
      req.user?.displayName || req.userPhone || req.user?.phoneNumber || req.user?.uid || "Admin";
    console.log(
      `🤖 [BOT RESUMED] Administrador '${adminIdentifier}' (${req.user?.uid || "sin-uid"}) reactivó el bot para el hilo '${threadId}' el ${new Date().toISOString()}`
    );

    return res.json({
      success: true,
      message: `Asistente virtual reactivado exitosamente para el hilo ${threadId}.`,
      thread_id: threadId,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error("❌ Error en resumeBot:", error);
    return res.status(500).json({ error: "Error reactivando el asistente virtual." });
  }
};
