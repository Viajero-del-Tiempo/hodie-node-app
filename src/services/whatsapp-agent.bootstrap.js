import { createWhatsAppPilot } from "./whatsapp-agent.service.js";
import { createWhatsAppDeliveryRepository } from "./whatsapp-delivery.repository.js";
import { createWhatsAppTransport, createWhatsAppSendQueue } from "./whatsapp-transport.service.js";
import { createAgentChatControl } from "./agent-chat-control.service.js";
import { createOwnMessageRepository, installWhatsAppClient, readAlertsPhone } from "./whatsapp-client.service.js";
import { createWhatsAppAlertDispatcher } from "./whatsapp-alert-dispatcher.service.js";
import { createAgentCheckpointStore } from "../agents/consultation/checkpoint-store.js";
import { createAgentAlertRepository } from "./agent-alert.repository.js";
import { createWhatsAppLifecycle } from "./whatsapp-lifecycle.service.js";
import { createOrderPdfJobService } from "./order-pdf-job.service.js";
import { createOrderConfirmationRepository } from "./order-confirmation.repository.js";
import { allowsAgentPhone } from "../config/agent-whatsapp.config.js";
import { maskedChat } from "./agent-telemetry.service.js";

// Solo el receptor real (o el launcher del emulador) llama a esta composición.
// Los módulos unitarios y el runner no importan config/whatsapp.js.
export async function createWhatsAppPilotInfrastructure({ config, client, MessageMedia, db, timestampNow,
  timestampFromMillis, resolvePhone, bankConfig, receiptStorage, uploadCustomizationImage,
  allowLocalImages = false, logger = value => console.info(JSON.stringify(value)), agentOptions = {},
  ownMessages, alertsPhone = readAlertsPhone(process.env), clock = { setTimeout, clearTimeout }, now = Date.now,
  generatePdf, transportOverrides = {} }) {
  let lifecycle;
  const isReady = () => lifecycle?.isReady() === true;
  const repository = createWhatsAppDeliveryRepository({ db, timestampFromMillis, now });
  const control = createAgentChatControl({ db, timestampFromMillis, now });
  if (config.enabled) {
    // Recuperar el índice y la bandeja de 7A sin abrir modelo ni transporte.
    const handoffs = await db.collection("handoff_threads").where("engine", "==", "agent").get();
    const alerts = createAgentAlertRepository({ db });
    for (const entry of handoffs.docs) {
      if (entry.data().active === false) continue;
      const chatId = entry.data().whatsappChatId ?? entry.id;
      await control.ensure(chatId, entry.data().userPhoneNumber);
      const root = await db.collection("agent_checkpoints").doc(chatId).get();
      const state = root.data()?.snapshot ?? await (await createAgentCheckpointStore({ db, chatId })).read();
      for (const alert of state?.guardianAlerts ?? []) {
        if (!alert.delivered) await alerts.request({ ...alert, chatId: alert.chatId ?? chatId, delivered: false });
      }
    }
  }
  ownMessages ??= installWhatsAppClient({ client, repository: createOwnMessageRepository({ db, timestampFromMillis, now }), config, resolvePhone, alertsPhone });
  const transportOptions = { client, MessageMedia, repository, allowLocalImages, logger, now,
    sendQueue: createWhatsAppSendQueue(), getSignal: () => lifecycle?.getSignal(), ...transportOverrides };
  const maintenance = createWhatsAppTransport(transportOptions);
  const { createProductionAgent } = await import("../agents/consultation/production-adapter.js");
  const pilot = createWhatsAppPilot({ config, repository, resolvePhone, transport: maintenance, logger, control, ownMessages,
    createRuntime: async (chatId, { signal }) => {
      let runtime;
      const transport = createWhatsAppTransport({ ...transportOptions, beforeSend: (_id, metadata) => runtime.assertCanSend(metadata) });
      try {
        runtime = await createProductionAgent({ db, chatId, timestampNow, timestampFromMillis, resolvePhone, signal, control, now,
          transport, bankConfig, receiptStorage, uploadCustomizationImage, logger, ...agentOptions });
        return runtime;
      } catch (error) { transport.close(); throw error; }
    },
  });
  const dispatcher = createWhatsAppAlertDispatcher({ db, client, alertsPhone, isReady, logger, clock, now,
    getSignal: () => lifecycle?.getSignal() });
  if (config.enabled) dispatcher.warnIfUnconfigured();
  const jobRepository = createOrderConfirmationRepository({ db, timestampNow, now });
  const canSendJob = async job => {
    if (!job || !config.enabled || !isReady()) return false;
    if ((await control.get(job.chatId))?.paused) return false;
    const phone = await resolvePhone(job.chatId, { sideEffectFree: true });
    return allowsAgentPhone(config, phone);
  };
  const pdfTransport = createWhatsAppTransport({ ...transportOptions, beforeSend: async chatId => {
    if (!await canSendJob({ chatId })) throw Object.assign(new Error("Entrega PDF suspendida"), { code: "PDF_WORKER_SUSPENDED", deliveryStarted: false });
  } });
  const pdfJobs = createOrderPdfJobService({ repository: jobRepository, now, clock, canProcess: canSendJob,
    watchJob: (job, block) => control.watch(job.chatId, current => { if (current?.paused) block(); }, () => {
      block(); logger({ code: "PDF_CHAT_CONTROL_READ_FAILED", chat: maskedChat(job.chatId) });
    }),
    generatePdf: generatePdf ?? (async order => (await import("./pdf.service.js")).generateOrderPDF(order, { bankConfig })),
    transport: { handlesDeliveryStart: true,
      sendText: (text, { job, ...options }) => pdfTransport.sendText(job.chatId, text, { ...options, origin: "order_receipt" }),
      sendPdf: (recipient, path, order, options) => pdfTransport.sendPdf(recipient, path, order, options),
    } });
  if (config.enabled) {
    pilot.suspend(); dispatcher.suspend(); pdfJobs.suspend();
    lifecycle = createWhatsAppLifecycle({ client, clock, now, logger,
      workers: [dispatcher, { start: () => pdfJobs.start({ logger }), suspend: pdfJobs.suspend, stop: pdfJobs.stop }],
      onSuspend: pilot.suspend, onReady: pilot.resume,
      requestAlert: alert => createAgentAlertRepository({ db }).request(alert),
      recordAck: async (chatId, id, ack) => {
        const own = await ownMessages.recordAck(chatId, id, ack);
        logger({ event: "whatsapp_ack", chat: maskedChat(chatId), ack, own });
      },
    });
    ownMessages.setConnection(lifecycle);
  }
  return { ...pilot, control, lifecycle, pdfJobs,
    start: () => lifecycle ? lifecycle.start() : client.initialize(),
    async shutdown() {
      // Suspender todo antes de esperar escrituras, SDK o renderizado en curso.
      pdfTransport.close();
      const results = await Promise.allSettled([pilot.shutdown(), lifecycle?.stop(), dispatcher.stop(), pdfJobs.stop()]);
      if (results.some(result => result.status === "rejected")) throw new Error("No se completó el cierre de todos los componentes del piloto");
    } };
}
