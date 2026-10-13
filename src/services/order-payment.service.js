// El servidor inyecta BANK_CONFIG. El runner inyecta una configuración ficticia.
export function validateOrderBankConfig(bank) {
  for (const field of ["bankName", "accountHolder", "documentId", "accountNumber", "currency", "alias"]) {
    if (typeof bank?.[field] !== "string" || !bank[field].trim()) {
      throw Object.assign(new Error("Configuración bancaria incompleta: " + field), { code: "INVALID_PAYMENT_CONFIG" });
    }
  }
  return Object.fromEntries(Object.entries(bank).map(([key, value]) => [key, value]));
}

export function renderExistingOrderMessage(order, currency) {
  return ["El pedido #" + order.orderNumber + " ya está registrado.",
    "Total: " + new Intl.NumberFormat("es-PY").format(order.total) + " " + currency,
    "Estado actual: " + order.status + "."].join("\n");
}

export function renderOrderPaymentMessage(order, bankConfig) {
  const bank = validateOrderBankConfig(bankConfig);
  const amount = new Intl.NumberFormat("es-PY").format(order.total) + " " + bank.currency;
  if (order.status !== "pending") return renderExistingOrderMessage(order, bank.currency);
  return [
    "*Tu pedido #" + order.orderNumber + " quedó registrado.*",
    "*Total: " + amount + "*",
    "Para pagarlo, transferí el total a:",
    "Banco: " + bank.bankName, "Titular: " + bank.accountHolder, "Cédula / RUC: " + bank.documentId,
    "Cuenta: " + bank.accountNumber, "Moneda: " + bank.currency, "Alias: " + bank.alias,
    "El equipo verifica el pago manualmente; el pedido está pendiente de pago.",
    "El PDF se envía por separado. Este resumen y el PDF no son una factura.",
    "Apenas confirmemos el pago, empezamos a prepararlo",
  ].join("\n");
}
