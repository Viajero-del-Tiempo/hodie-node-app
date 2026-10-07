// Renderiza únicamente la foto del pedido, nunca datos del perfil actual.
export function renderOrderRecipient(doc, order) {
  const address = order.shippingAddress ?? {};
  if (address.recipientName) doc.text(`Destinatario: ${address.recipientName}`);
  if (order.shippingMethod === "transportadora_contra_entrega" && address.recipientDocument) {
    doc.text(`Cédula del destinatario: ${address.recipientDocument}`);
  }
}

export function renderOrderBilling(doc, order) {
  doc.font("Poppins-Bold").fontSize(18).text("Datos de facturación");
  doc.font("Poppins").fontSize(12);
  if (order.billing === undefined || order.billing === null) {
    doc.text("Datos de facturación no registrados.");
  } else if (!order.billing.invoiceRequested) {
    doc.text("Consumidor final.");
  } else {
    doc.text("Solicita factura con RUC.");
    doc.text(`Razón social: ${order.billing.legalName}`);
    doc.text(`RUC: ${order.billing.ruc}`);
    if (order.billing.rucValidation?.status === "mismatch_confirmed") {
      doc.text("Aviso: el cliente confirmó este RUC aunque su dígito verificador no coincide.");
    }
  }
  doc.moveDown(0.5).text("Este documento es un resumen del pedido, no es una factura.");
}
