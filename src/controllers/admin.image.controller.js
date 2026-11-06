import { CatalogError } from "../validators/catalog.validator.js";
import { validateCatalogImage } from "../validators/catalog-image.validator.js";

async function uploadProductionImage(image) {
  const { uploadCatalogImageToCloudinary } = await import("../services/cloudinary.service.js");
  return uploadCatalogImageToCloudinary(image);
}
export function createAdminImageController(uploadImage = uploadProductionImage) {
  return async (req, res) => {
    try {
      const image = validateCatalogImage(req.body);
      const imageUrl = await uploadImage(image);
      return res.status(201).json({ success: true, imageUrl });
    } catch (error) {
      if (error instanceof CatalogError) return res.status(error.status).json({ error: error.message, field: error.field });
      console.error("Error subiendo imagen del catálogo:", error.code ?? error.name);
      return res.status(error.code === "MISSING_CREDENTIALS" ? 500 : 502).json({
        error: "No se pudo subir la imagen. Conservá el archivo y volvé a intentar.", field: "image",
      });
    }
  };
}
