const money = value => new Intl.NumberFormat("es-PY").format(value) + " Gs.";
export function renderQuoteSummary(quote) {
  if (!quote.items) return "Todavía faltan productos para calcular el subtotal.";
  const lines = quote.items.map(item => "• " + item.quantity + " × " + item.productName
    + (item.variantLabel ? " · " + item.variantLabel : "")
    + " · Precio por unidad: " + money(item.price)
    + (item.selectedPackaging ? " · " + item.selectedPackaging.name + ": " + money(item.selectedPackaging.price) + " por unidad" : "")
    + (item.subtotal !== undefined ? " · Subtotal de esta línea: " + money(item.subtotal) : "")
    + (quote.mode === "informative" ? "" : item.customization ? " · Texto: “" + item.customization + "”" : item.customizationDeclined ? " · Sin personalización" : item.customizationPending ? " · Texto pendiente" : "")
    + (item.customizationImageUrl ? " · Imagen de referencia recibida" : ""));
  lines.push("*Subtotal de productos: " + money(quote.subtotal) + "*");
  if (quote.shipping) lines.push("Envío: " + quote.shipping.label + ".");
  if (quote.shippingAddress) {
    const address = quote.shippingAddress;
    lines.push("Destinatario: " + address.recipientName + ". Dirección: " + [address.street, address.city, address.department].filter(Boolean).join(", ") + ".");
    if (address.recipientDocument) lines.push("Cédula: " + address.recipientDocument + ".");
    if (quote.contactPhone) lines.push("Teléfono de contacto: " + quote.contactPhone + ".");
  }
  if (quote.billing?.invoiceRequested === false) lines.push("Facturación: consumidor final.");
  else if (quote.billing?.invoiceRequested === true) lines.push("Factura con RUC: " + (quote.billing.legalName ?? "por completar") + " · " + (quote.billing.ruc ?? "por completar") + ".");
  if (quote.confirmable) lines.push("*Total del pedido: " + money(quote.total) + "*");
  else lines.push(quote.mode === "informative"
    ? "Es un cálculo informativo; no modifica el carrito ni es una cotización para confirmar."
    : "Es un subtotal informativo; todavía faltan datos para completar la cotización.");
  return lines.join("\n");
}
