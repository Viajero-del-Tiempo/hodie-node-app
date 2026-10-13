import { createPaymentReceiptRepository } from "./payment-receipt.repository.js";
import { createPrivateReceiptStorage } from "./payment-receipt.storage.js";
import { createPaymentReceiptService } from "./payment-receipt.service.js";
import { createPaymentReceiptConfig } from "./payment-receipt.config.js";

export function createReceiptInfrastructure({ db, storage = createPrivateReceiptStorage(), now = Date.now }) {
  const repository = createPaymentReceiptRepository({ db, now });
  const cleanup = createPaymentReceiptService({ repository, storage, now, config: createPaymentReceiptConfig(process.env) });
  return { repository, storage, cleanup };
}
