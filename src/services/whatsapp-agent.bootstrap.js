import { createWhatsAppPilot } from "./whatsapp-agent.service.js";
import { createWhatsAppDeliveryRepository } from "./whatsapp-delivery.repository.js";
import { createWhatsAppTransport } from "./whatsapp-transport.service.js";

// Solo el receptor real (o el launcher del emulador) llama a esta composición.
// Los módulos unitarios y el runner no importan config/whatsapp.js.
export async function createWhatsAppPilotInfrastructure({ config, client, MessageMedia, db, timestampNow,
  timestampFromMillis, resolvePhone, bankConfig, receiptStorage, uploadCustomizationImage,
  allowLocalImages = false, logger = value => console.info(JSON.stringify(value)), agentOptions = {} }) {
  const repository = createWhatsAppDeliveryRepository({ db, timestampFromMillis });
  const transportOptions = { client, MessageMedia, repository, allowLocalImages, logger };
  const maintenance = createWhatsAppTransport(transportOptions);
  const { createProductionAgent } = await import("../agents/consultation/production-adapter.js");
  return createWhatsAppPilot({ config, repository, resolvePhone, transport: maintenance, logger,
    createRuntime: (chatId, { signal }) => createProductionAgent({ db, chatId, timestampNow, timestampFromMillis, resolvePhone, signal,
      transport: createWhatsAppTransport(transportOptions), bankConfig, receiptStorage,
      uploadCustomizationImage, logger, ...agentOptions }),
  });
}
