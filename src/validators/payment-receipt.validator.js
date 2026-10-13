import { cartIssue } from "../services/cart.service.js";
import { RECEIPT_MAX_BYTES } from "../services/payment-receipt.config.js";

export function validatePaymentReceipt({ data, mimeType, filename } = {}) {
  if (!Buffer.isBuffer(data) || !data.length) throw cartIssue("ADJUNTO_NO_DISPONIBLE", "attachmentId", "El archivo no está disponible. Volvé a enviarlo.");
  if (data.length > RECEIPT_MAX_BYTES) throw cartIssue("COMPROBANTE_DEMASIADO_GRANDE", "attachmentId", "El comprobante supera el tamaño admitido.");
  const mime = String(mimeType ?? "").toLowerCase().replace(/^image\/jpg$/, "image/jpeg");
  const signatures = {
    "image/png": bytes => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "image/jpeg": bytes => bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    "image/webp": bytes => bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP",
    "image/gif": bytes => /^GIF8[79]a/.test(bytes.toString("ascii", 0, 6)),
    "application/pdf": bytes => /^%PDF-\d\.\d/.test(bytes.toString("ascii", 0, 8)) && /%%EOF\s*$/.test(bytes.subarray(-1024).toString("ascii")),
  };
  if (!signatures[mime]) throw cartIssue("FORMATO_COMPROBANTE_NO_ADMITIDO", "attachmentId", "Enviá una imagen o un PDF del comprobante.");
  if (!signatures[mime](data)) throw cartIssue("FIRMA_COMPROBANTE_INVALIDA", "attachmentId", "El contenido no coincide con el formato del archivo.");
  const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf" }[mime];
  // Nombre de descarga, sin rutas, controles, comillas ni cabeceras inyectables.
  const name = typeof filename === "string" ? filename.replace(/[^\p{L}\p{N} ._()-]/gu, "_").slice(-120).trim() : "";
  const basename = name.replace(/\.[a-z0-9]+$/iu, "") || "comprobante";
  return { data, mimeType: mime, filename: basename + "." + extension, extension, size: data.length };
}
