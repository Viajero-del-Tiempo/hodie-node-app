/**
 * Configuración centralizada de datos bancarios para transferencias y pagos.
 * Única fuente de verdad para mensajes de WhatsApp, mensajes de contingencia y PDF.
 */
export const BANK_CONFIG = {
  bankName: process.env.BANK_NAME || "ueno bank",
  accountHolder: process.env.BANK_ACCOUNT_HOLDER || "SILVIA ANALIA ZIMARDI MAYEREGGER",
  documentId: process.env.BANK_DOCUMENT_ID || "4180821",
  accountNumber: process.env.BANK_ACCOUNT_NUMBER || "6192151586",
  currency: process.env.BANK_CURRENCY || "Gs",
  alias: process.env.BANK_ALIAS || "+595987305945 (celular)",
};
