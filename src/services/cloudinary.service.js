import crypto from "node:crypto";
import { CLOUDINARY_CONFIG } from "../config/cloudinary.config.js";

export const MAX_MEDIA_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Sube una imagen de personalización a Cloudinary utilizando la API de subida firmada (Signed Upload).
 *
 * @param {Object} params
 * @param {string} params.base64 - Contenido del archivo codificado en Base64
 * @param {string} params.mimetype - Tipo MIME de la imagen (ej: 'image/jpeg', 'image/png')
 * @returns {Promise<string>} URL segura de la imagen alojada en Cloudinary
 */
export function createSignedImageUploader({ config = CLOUDINARY_CONFIG, fetchImpl = fetch, now = Date.now, newId = crypto.randomUUID } = {}) {
  return async ({ base64, mimetype }, { folder = config.folder, prefix = "custom" } = {}) => {
    if (!base64 || typeof base64 !== "string") {
      throw new Error("Contenido de imagen en base64 requerido para la subida.");
    }

    // 1. Validar tamaño máximo (10 MB)
    const byteLength = Buffer.byteLength(base64, "base64");
    if (byteLength > MAX_MEDIA_BYTES) {
      const error = new Error(`El archivo excede el tamaño máximo permitido de 10 MB (tamaño: ${(byteLength / (1024 * 1024)).toFixed(2)} MB).`);
      error.code = "MEDIA_TOO_LARGE";
      throw error;
    }

    // 2. Validar tipo MIME permitido (imágenes estándar, no documentos ni vectores)
    const cleanMime = (mimetype || "").toLowerCase();
    const allowedMimes = ["image/jpeg", "image/png", "image/webp", "image/jpg"];
    if (!allowedMimes.includes(cleanMime)) {
      const error = new Error(`Tipo de archivo no permitido para personalización: ${cleanMime}. Formatos aceptados: JPG, PNG, WEBP.`);
      error.code = "INVALID_MIME_TYPE";
      throw error;
    }

    // 3. Validar credenciales de Cloudinary
    const { cloudName, apiKey, apiSecret } = config;
    if (!cloudName || !apiKey || !apiSecret) {
      const error = new Error(
        "Credenciales de Cloudinary incompletas en variables de entorno (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY o CLOUDINARY_API_SECRET)."
      );
      error.code = "MISSING_CREDENTIALS";
      throw error;
    }

    // 4. Parámetros de subida firmada
    const timestamp = Math.floor(now() / 1000);
    const unguessablePublicId = `${prefix}_${now()}_${newId().replace(/-/g, "")}`;

    // La firma de Cloudinary requiere ordenar alfabéticamente los parámetros a firmar: folder, public_id, timestamp
    const stringToSign = `folder=${folder}&public_id=${unguessablePublicId}&timestamp=${timestamp}${apiSecret}`;
    const signature = crypto.createHash("sha1").update(stringToSign).digest("hex");

    // 5. Ensamblar FormData para la API REST de Cloudinary
    const formData = new FormData();
    formData.append("file", `data:${cleanMime};base64,${base64}`);
    formData.append("api_key", apiKey);
    formData.append("timestamp", String(timestamp));
    formData.append("folder", folder);
    formData.append("public_id", unguessablePublicId);
    formData.append("signature", signature);

    const uploadEndpoint = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;

    const response = await fetchImpl(uploadEndpoint, {
      method: "POST",
      body: formData,
    });

    const data = await response.json();

    if (!response.ok || !data.secure_url) {
      const message = data.error?.message || `Fallo en respuesta Cloudinary (HTTP ${response.status})`;
      const error = new Error(`Error en Cloudinary API: ${message}`);
      error.code = "CLOUDINARY_API_ERROR";
      throw error;
    }

    return data.secure_url;
  };
}

const signedUpload = createSignedImageUploader();
// Se conserva el contrato y la carpeta de las imágenes de personalización.
export const uploadCustomizationImageToCloudinary = image => signedUpload(image);
export const uploadCatalogImageToCloudinary = image => signedUpload(image, {
  folder: CLOUDINARY_CONFIG.catalogFolder, prefix: "catalog",
});
