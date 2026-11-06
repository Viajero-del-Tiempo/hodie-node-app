import { evalFixtures } from "./eval-fixtures.js";

export function productsWithImages() {
  const fixtures = evalFixtures(), base = fixtures.products[0];
  fixtures.products = ["a", "b", "c", "d"].map((suffix, index) => ({ ...structuredClone(base),
    id: "product-" + suffix, name: "Producto de prueba " + (index + 1),
    variants: [{ ...structuredClone(base.variants[0]), id: "variant-" + suffix, sku: "TEST-" + suffix,
      price: 100 * (index + 1), imageUrls: ["https://example.test/" + suffix + ".png", "https://example.test/" + suffix + "-extra.png"] }],
  }));
  return fixtures;
}
