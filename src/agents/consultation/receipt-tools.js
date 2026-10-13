import { createPaymentReceiptService } from "../../services/payment-receipt.service.js";
import { createPaymentReceiptConfig } from "../../services/payment-receipt.config.js";

export function createReceiptTools(runtime) {
  const service = createPaymentReceiptService({ repository: runtime.receiptRepository, storage: runtime.receiptStorage,
    getState: runtime.getState, getAttachment: runtime.getTurnAttachment, getTurn: runtime.getTurnContext,
    now: runtime.now, config: runtime.receiptConfig ?? createPaymentReceiptConfig(process.env) });
  runtime.paymentReceipts = service;
  runtime.getRegisteredReceiptAcknowledgement = service.acknowledgementForTurn;
  return { async registrar_comprobante(args, context = {}) {
    try { return await service.register(args, context); }
    catch (error) {
      context.signal?.throwIfAborted();
      if (error.statusCode >= 400 && error.statusCode < 500) return { code: error.code, field: error.field, message: error.message };
      throw error;
    }
  } };
}
