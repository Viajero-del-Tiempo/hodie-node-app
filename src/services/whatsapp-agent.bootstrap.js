import { createWhatsAppPilot } from "./whatsapp-agent.service.js";
import { createWhatsAppDeliveryRepository } from "./whatsapp-delivery.repository.js";
import { createWhatsAppTransport } from "./whatsapp-transport.service.js";
import { createAgentChatControl } from "./agent-chat-control.service.js";
import { createOwnMessageRepository, installWhatsAppClient, readAlertsPhone } from "./whatsapp-client.service.js";
import { createWhatsAppAlertDispatcher } from "./whatsapp-alert-dispatcher.service.js";
import { createAgentCheckpointStore } from "../agents/consultation/checkpoint-store.js";
import { createAgentAlertRepository } from "./agent-alert.repository.js";

// Solo el receptor real (o el launcher del emulador) llama a esta composición.
// Los módulos unitarios y el runner no importan config/whatsapp.js.
export async function createWhatsAppPilotInfrastructure({ config, client, MessageMedia, db, timestampNow,
  timestampFromMillis, resolvePhone, bankConfig, receiptStorage, uploadCustomizationImage,
  allowLocalImages = false, logger = value => console.info(JSON.stringify(value)), agentOptions = {},
  ownMessages, alertsPhone = readAlertsPhone(process.env), isReady = () => Boolean(client.info) }) {
  const repository = createWhatsAppDeliveryRepository({ db, timestampFromMillis });
  const control = createAgentChatControl({ db, timestampFromMillis });
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
  ownMessages ??= installWhatsAppClient({ client, repository: createOwnMessageRepository({ db, timestampFromMillis }), config, resolvePhone, alertsPhone });
  const transportOptions = { client, MessageMedia, repository, allowLocalImages, logger };
  const maintenance = createWhatsAppTransport(transportOptions);
  const { createProductionAgent } = await import("../agents/consultation/production-adapter.js");
  const pilot = createWhatsAppPilot({ config, repository, resolvePhone, transport: maintenance, logger, control, ownMessages,
    createRuntime: async (chatId, { signal }) => {
      let runtime;
      const transport = createWhatsAppTransport({ ...transportOptions, beforeSend: (_id, metadata) => runtime.assertCanSend(metadata) });
      try {
        runtime = await createProductionAgent({ db, chatId, timestampNow, timestampFromMillis, resolvePhone, signal, control,
          transport, bankConfig, receiptStorage, uploadCustomizationImage, logger, ...agentOptions });
        return runtime;
      } catch (error) { transport.close(); throw error; }
    },
  });
  const dispatcher = createWhatsAppAlertDispatcher({ db, client, alertsPhone, isReady, logger });
  if (config.enabled) dispatcher.start();
  return { ...pilot, control, async shutdown() { await pilot.shutdown(); await dispatcher.stop(); } };
}
