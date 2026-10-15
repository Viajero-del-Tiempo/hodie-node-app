import { evalFixtures } from "./eval-fixtures.js";

export function packagingImagesFixtures() {
  const fixtures = evalFixtures(), product = fixtures.products[0];
  product.variants.push({ ...structuredClone(product.variants[0]), id: "variant-b", sku: "TEST-B", options: { finish: "Opción Beta" }, price: 150 });
  product.packagingOptions = [
    { type: "pack/a", name: "Empaque Alfa", price: 10, imageUrl: "https://example.test/foto-sin-convencion.png" },
    { type: "pack-b", name: "Empaque Beta", price: 20, imageUrl: "https://example.test/otra-foto.png" },
    { type: "pack-c", name: "Empaque Gamma", price: 0 },
    { type: "pack-d", name: "Empaque Delta", price: 30, imageUrl: "https://example.test/tercera.png" },
  ];
  return fixtures;
}
export const packagingPresentation = (packagingType, variantId = "variant-a") => ({ productId: "product-a", packagingType,
  ...(variantId === undefined ? {} : { variantId }) });
