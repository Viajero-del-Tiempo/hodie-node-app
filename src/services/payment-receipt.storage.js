import { createHash } from "node:crypto";
import { CLOUDINARY_CONFIG } from "../config/cloudinary.config.js";
import { RECEIPT_MAX_BYTES } from "./payment-receipt.config.js";

// Nunca devuelve URLs. raw conserva el original sin conversiones; authenticated
// impide descarga pública. La firma de descarga permanece dentro del servidor.
export function createPrivateReceiptStorage({ config = CLOUDINARY_CONFIG, fetchImpl = fetch, now = Date.now,
  folder = process.env.CLOUDINARY_RECEIPTS_FOLDER || "payment-receipts" } = {}) {
  if (!/^[a-z0-9/_-]+$/iu.test(folder)) throw new Error("Carpeta privada de comprobantes inválida");
  function credentials() {
    if (!config.cloudName || !config.apiKey || !config.apiSecret) throw new Error("Falta configurar almacenamiento privado de comprobantes");
  }
  const sign = params => createHash("sha1").update(Object.keys(params).sort().map(key => key + "=" + params[key]).join("&") + config.apiSecret).digest("hex");
  const params = value => { const signed = { ...value, timestamp: Math.floor(now() / 1000) };
    return { ...signed, api_key: config.apiKey, signature: sign(signed) }; };
  const endpoint = action => "https://api.cloudinary.com/v1_1/" + encodeURIComponent(config.cloudName) + "/raw/" + action;
  return {
    descriptor(id, extension) { return { publicId: folder + "/" + id + "." + extension, resourceType: "raw", deliveryType: "authenticated", format: extension }; },
    async put(asset, file, { signal } = {}) {
      credentials(); signal?.throwIfAborted();
      const form = new FormData();
      for (const [key, value] of Object.entries(params({ public_id: asset.publicId, type: "authenticated", overwrite: false, backup: false }))) form.append(key, String(value));
      form.append("file", new Blob([file.data], { type: file.mimeType }), file.filename);
      const response = await fetchImpl(endpoint("upload"), { method: "POST", body: form, redirect: "error", signal });
      const result = await response.json(); signal?.throwIfAborted();
      if (!response.ok || result.type !== "authenticated" || result.resource_type !== "raw" || result.public_id !== asset.publicId) {
        throw new Error("No se pudo guardar el comprobante en almacenamiento autenticado");
      }
    },
    async read(asset, { signal } = {}) {
      credentials();
      if (asset.resourceType !== "raw" || asset.deliveryType !== "authenticated") throw new Error("Descriptor privado inválido");
      const query = new URLSearchParams(params({ public_id: asset.publicId,
        type: "authenticated", attachment: true, expires_at: Math.floor(now() / 1000) + 60 }));
      const response = await fetchImpl(endpoint("download") + "?" + query, { redirect: "error", signal });
      if (!response.ok) throw new Error("No se pudo descargar el comprobante privado");
      const parts = []; let size = 0;
      for await (const chunk of response.body) {
        signal?.throwIfAborted(); size += chunk.length;
        if (size > RECEIPT_MAX_BYTES) throw new Error("El archivo privado supera el límite admitido");
        parts.push(Buffer.from(chunk));
      }
      return Buffer.concat(parts);
    },
    async delete(asset, { signal } = {}) {
      credentials();
      const response = await fetchImpl(endpoint("destroy"), { method: "POST", redirect: "error", signal,
        body: new URLSearchParams(params({ public_id: asset.publicId, type: "authenticated", invalidate: true })) });
      const result = await response.json();
      if (!response.ok || !["ok", "not found"].includes(result.result)) throw new Error("No se pudo eliminar el comprobante privado");
    },
  };
}
