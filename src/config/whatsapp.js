import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from "qrcode-terminal";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { compiledGraph } from "../agents/graph.js";

export const whatsappClient = new Client({
  authStrategy: new LocalAuth({
    dataPath: "./sessions",
    clientId: "client-one",
  }),
  webVersionCache: {
    type: "remote",
    remotePath:
      "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html",
  },
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-gpu",
      "--disable-software-rasterizer",
    ],
    bypassCSP: true,
    ignoreHTTPSErrors: true,
  },
  authTimeoutMs: 60000,
});

whatsappClient.on("qr", (qr) => {
  console.log("📱 Escaneá este QR para iniciar sesión en WhatsApp:");
  qrcode.generate(qr, { small: true });
});

whatsappClient.on("ready", async () => {
  console.log("✅ WhatsApp listo");
  console.log(
    "📌 WhatsApp Web Version:",
    await whatsappClient.getWWebVersion(),
  );
});

/**
 * Determina una descripción amigable del archivo adjunto según su mimetype o tipo de mensaje
 * para alimentar contextualmente el userText del turno sin necesidad de descargar el archivo.
 * @param {string} [mimetype]
 * @param {string} [messageType]
 * @returns {string}
 */
export const getMediaDescription = (mimetypeOrObj, messageType) => {
  if (messageType === "sticker") return "Sticker adjunto";
  const mimetype =
    typeof mimetypeOrObj === "object" && mimetypeOrObj !== null
      ? mimetypeOrObj.mimetype
      : mimetypeOrObj;
  if (!mimetype) return "Archivo adjunto";
  const mime = String(mimetype).toLowerCase();
  if (mime.startsWith("image/")) return "Imagen adjunta";
  if (mime.startsWith("audio/")) return "Audio adjunto";
  if (mime.startsWith("video/")) return "Video adjunto";
  if (mime.startsWith("application/") || mime.startsWith("text/")) return "Documento adjunto";
  return "Archivo adjunto";
};

/**
 * Cola en memoria para serializar invocaciones del grafo por queueKey (whatsappChatId).
 * Map<string, Promise<any>>
 */
export const threadQueues = new Map();

/**
 * Serializa la ejecución de tareas asíncronas por queueKey garantizando procesamiento
 * estrictamente secuencial (FIFO) para un mismo cliente/chat, mientras chats distintos
 * continúan ejecutándose concurrentemente en paralelo.
 * Implementa un timeout configurable (60s por defecto) vía Promise.race. Al vencer, libera
 * la cola para el siguiente mensaje del chat, despacha el mensaje de contingencia al cliente,
 * alerta al admin indicando el timeout y loguea el tiempo transcurrido.
 * Limpia automáticamente la entrada del Map al vaciarse la cola para no acumular memoria.
 *
 * @template T
 * @param {string} queueKey
 * @param {() => Promise<T>} taskFn
 * @param {number} [timeoutMs=60000] - Tiempo límite en milisegundos antes de abortar la espera del turno
 * @returns {Promise<T>}
 */
export const runInThreadQueue = async (queueKey, taskFn, timeoutMs = 60000) => {
  const previousPromise = threadQueues.get(queueKey) || Promise.resolve();

  let taskResolve, taskReject;
  const taskPromise = new Promise((resolve, reject) => {
    taskResolve = resolve;
    taskReject = reject;
  });

  // Evitar que un rechazo sin nadie esperando detrás genere unhandledRejection
  taskPromise.catch(() => {});

  threadQueues.set(queueKey, taskPromise);

  // Esperar a que la tarea anterior del mismo chat culmine (resuelva o falle)
  try {
    await previousPromise;
  } catch {
    // Evitar que el fallo de un turno anterior bloquee los turnos subsiguientes del chat
  }

  const abortController = new AbortController();
  const { signal } = abortController;

  const startTime = Date.now();
  let timerId = null;

  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      const elapsed = Date.now() - startTime;
      abortController.abort(new Error(`Queue task timeout after ${elapsed}ms for chat ${queueKey}`));
      const timeoutErr = new Error(`Queue task timeout after ${elapsed}ms for chat ${queueKey}`);
      timeoutErr.name = "QueueTimeoutError";
      timeoutErr.elapsed = elapsed;
      reject(timeoutErr);
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([taskFn(signal), timeoutPromise]);
    clearTimeout(timerId);
    taskResolve(result);
    return result;
  } catch (err) {
    clearTimeout(timerId);
    taskReject(err);

    if (err.name === "QueueTimeoutError" || err.message?.includes("Queue task timeout")) {
      const elapsed = err.elapsed || (Date.now() - startTime);
      console.error(`⏱️ [TIMEOUT COLA] Tarea expirada tras ${elapsed}ms para chat ${queueKey}. Liberando cola.`);

      // Mandar mensaje de contingencia al cliente
      try {
        const clientFallback =
          "Disculpá la demora, tuvimos una sobrecarga técnica momentánea. 🛠️\n" +
          "Ya notificamos a nuestro equipo para atenderte a la brevedad.";
        await whatsappClient.sendMessage(queueKey, clientFallback, { sendSeen: false });
      } catch (clientErr) {
        console.warn(`No se pudo enviar mensaje de contingencia por timeout a ${queueKey}:`, clientErr.message);
      }

      // Mandar alerta al admin indicando que fue un timeout
      try {
        const adminPhone = process.env.ADMIN_WHATSAPP_PHONE;
        if (adminPhone) {
          const adminChatId = adminPhone.includes("@") ? adminPhone : `${adminPhone}@c.us`;
          const adminAlert =
            `🚨 *Timeout en Cola de Atención WhatsApp*\n\n` +
            `• *ChatId:* ${queueKey}\n` +
            `• *Tiempo transcurrido:* ${elapsed}ms (límite: ${timeoutMs}ms)\n` +
            `• *Detalle:* La tarea excedió el tiempo límite y fue cancelada para liberar la cola del cliente.\n\n` +
            `👉 Por favor verificar si el flujo o agente está bloqueado.`;
          await whatsappClient.sendMessage(adminChatId, adminAlert, { sendSeen: false });
        }
      } catch (adminErr) {
        console.warn("No se pudo notificar al admin sobre el timeout:", adminErr.message);
      }
    }

    throw err;
  } finally {
    clearTimeout(timerId);
    // Si la promesa actual sigue siendo la última encolada para este chat, limpiar la entrada del Map
    if (threadQueues.get(queueKey) === taskPromise) {
      threadQueues.delete(queueKey);
    }
  }
};

whatsappClient.on("message", async (mensaje) => {
  // Ignorar mensajes enviados por el propio bot (fromMe)
  if (mensaje.fromMe) return;

  // 1. Filtrar mensajes de grupos (@g.us) o estados/historias (status@broadcast)
  // El bot opera exclusivamente en chats individuales
  if (!mensaje.from || mensaje.from.endsWith("@g.us") || mensaje.from === "status@broadcast") {
    return;
  }

  // 2. Identificador de chat tal cual lo entrega WhatsApp (@c.us o @lid) para respuestas exclusivas
  const whatsappChatId = mensaje.from;

  // Punto 2: Encolar inmediatamente al inicio usando whatsappChatId para preservar el orden estricto de llegada.
  // Todo el procesamiento (getContact, metadatos de media, grafo) se ejecuta dentro de la cola
  // para que un mensaje de texto posterior nunca se adelante a una foto enviada antes.
  try {
    await runInThreadQueue(whatsappChatId, async (signal) => {
      // Si no hay texto ni archivo adjunto, no procesar
      if (!mensaje.body && !mensaje.hasMedia) return;

      // 3. Número canónico de teléfono del contacto (E.164) para identificación, checkpointer y lógica de negocio
      let userPhoneNumber = "";
      try {
        const contact = await mensaje.getContact();
        userPhoneNumber = contact?.number || "";
      } catch (contactErr) {
        console.warn("⚠️ No se pudo obtener contacto del mensaje:", contactErr.message);
        // Fallback si getContact() falla y el mensaje proviene de @c.us
        userPhoneNumber = mensaje.from.includes("@c.us") ? mensaje.from.replace("@c.us", "") : "";
      }

      // 4. Procesar metadatos de archivo adjunto sin llamar a downloadMedia()
      // NOTA DE ARQUITECTURA: Ningún agente actual consume el binario de la imagen.
      // Leemos directamente el mimetype que ya trae el mensaje (mensaje._data?.mimetype o mensaje.type)
      // sin descargar el archivo, ahorrando CPU, ancho de banda y evitando saturar el límite de 1 MiB de Firestore.
      let incomingMedia = null;
      if (mensaje.hasMedia) {
        const mime = mensaje._data?.mimetype || "";
        incomingMedia = {
          mimetype: mime || "application/octet-stream",
          filename: mensaje._data?.filename || `adjunto-${Date.now()}`,
        };
      }

      // Punto 4: Descripción amigable según mimetype sin descargar media
      const mediaMime = mensaje._data?.mimetype;
      const userText = mensaje.body || (incomingMedia ? getMediaDescription(mediaMime, mensaje.type) : "");
      console.log(`📩 Mensaje entrante de +${userPhoneNumber || "desconocido"} (${whatsappChatId}): "${userText}"`);

      // 5. Invocación reactiva del grafo multi-agente
      // El thread_id del grafo sigue siendo userPhoneNumber con fallback a whatsappChatId
      let threadId = userPhoneNumber;
      if (!threadId) {
        console.warn(`⚠️ userPhoneNumber no disponible para ${whatsappChatId}. Usando whatsappChatId como fallback de thread_id.`);
        threadId = whatsappChatId;
      }

      if (!threadId) {
        console.error(`❌ Imposible invocar el grafo: tanto userPhoneNumber como whatsappChatId están vacíos.`);
        return;
      }

      try {
        const inputState = {
          messages: [new HumanMessage(userText)],
          userPhoneNumber,
          whatsappChatId,
          incomingMedia,
        };

        const config = {
          configurable: {
            thread_id: threadId,
          },
          signal,
        };

        const finalState = await compiledGraph.invoke(inputState, config);

        // Si la tarea fue abortada por timeout durante la ejecución del grafo, no enviar respuesta tardía
        if (signal.aborted) {
          console.log(`🛑 Tarea abortada para ${whatsappChatId}. Omitiendo envío de respuesta tardía.`);
          return;
        }

        // 6. Extraer y enviar la respuesta generada por los agentes
        const lastMessage = finalState.messages[finalState.messages.length - 1];

        // Solo enviamos si el último mensaje es un AIMessage nuevo
        // (si el grafo terminó en silencio por handoff activo, lastMessage será el HumanMessage entrante)
        const isAiMessage =
          lastMessage instanceof AIMessage ||
          lastMessage?._getType?.() === "ai" ||
          lastMessage?.constructor?.name === "AIMessage";

        if (isAiMessage && lastMessage.content) {
          if (signal.aborted) {
            console.log(`🛑 Tarea abortada para ${whatsappChatId}. Omitiendo envío de respuesta tardía.`);
            return;
          }

          const responseText =
            typeof lastMessage.content === "string"
              ? lastMessage.content
              : JSON.stringify(lastMessage.content);

          if (responseText && responseText.trim()) {
            await whatsappClient.sendMessage(whatsappChatId, responseText, {
              quotedMessageId: mensaje.id._serialized,
              sendSeen: false,
            });
            console.log(`📤 Respuesta enviada a ${whatsappChatId}`);
          }
        } else {
          console.log(`🔇 Sin respuesta automática para ${whatsappChatId} (handoff humano activo o nodo terminal mudo).`);
        }
      } catch (error) {
        if (signal.aborted || error.name === "AbortError") {
          console.log(`🛑 Invocación del grafo cancelada por timeout/abort para ${whatsappChatId}.`);
          return;
        }

        console.error("❌ Error inesperado ejecutando compiledGraph.invoke:", error);

        // Mensaje de contingencia al cliente
        try {
          const clientFallback =
            "Disculpá las molestias, tuvimos un inconveniente técnico momentáneo. 🛠️\n" +
            "Ya notificamos a nuestro equipo para atenderte a la brevedad.";
          await whatsappClient.sendMessage(whatsappChatId, clientFallback, {
            quotedMessageId: mensaje.id._serialized,
            sendSeen: false,
          });
        } catch (clientErr) {
          console.error("Error enviando mensaje de contingencia al cliente:", clientErr.message);
        }

        // Alerta formal de error al administrador
        try {
          const adminPhone = process.env.ADMIN_WHATSAPP_PHONE;
          if (adminPhone) {
            const adminChatId = adminPhone.includes("@") ? adminPhone : `${adminPhone}@c.us`;
            const adminAlert =
              `🚨 *Error Crítico Inesperado en Bot de WhatsApp*\n\n` +
              `• *Cliente:* +${userPhoneNumber || "desconocido"}\n` +
              `• *ChatId:* ${whatsappChatId}\n` +
              `• *Mensaje recibido:* "${userText}"\n` +
              `• *Error:* ${error.message || "Error no controlado"}\n\n` +
              `👉 Por favor verificar la conversación manualmente.`;
            await whatsappClient.sendMessage(adminChatId, adminAlert, { sendSeen: false });
          }
        } catch (adminErr) {
          console.warn("No se pudo notificar al admin sobre el error crítico:", adminErr.message);
        }
      }
    });
  } catch (queueErr) {
    if (queueErr?.name !== "QueueTimeoutError") {
      console.error(`❌ Error en cola para ${whatsappChatId}:`, queueErr);
    }
  }
});

export const initializeWhatsapp = async () => {
  try {
    await whatsappClient.initialize();
  } catch (error) {
    console.error("Error initializing WhatsApp client:", error);
  }
};

export { MessageMedia };
