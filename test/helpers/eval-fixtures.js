import YAML from "yaml";
import { parseCases } from "../eval/load-cases.js";

export function evalFixtures() {
  return {
    categories: [{ id: "group-a", name: "Categoría Alfa", order: 1 }],
    products: [{
      id: "product-a", name: "Producto Alfa", categoryId: "group-a", tags: [],
      attributes: {}, optionNames: ["finish"],
      variants: [{ id: "variant-a", sku: "TEST-A", options: { finish: "Opción Alfa" }, price: 100, stock: 8 }],
      customization: { allowed: true, allowsText: true, allowsImage: false, maxChars: 20 },
      packagingOptions: [{ type: "pack-a", name: "Empaque Alfa", price: 10 }],
    }],
    policies: { topic_a: "Política ficticia de prueba." },
    orders: [{
      orderNumber: "test-order-a", userPhoneNumber: "595900000001", status: "pending", total: 100,
      items: [{ productName: "Producto Alfa", variantLabel: "Opción Alfa", quantity: 1 }],
    }],
  };
}
export function evalCase(overrides = {}) {
  return {
    id: "EVAL-1", category: "example", turns: [{ user: "Hola" }],
    expect: { must: ["Responde al cliente."], handoff: "no" }, ...overrides,
  };
}
export function evalCart(overrides = {}) {
  return {
    lineas: [{ producto: "product-a", variante: "variant-a", cantidad: 1, texto: null, empaque: null }],
    ...overrides,
  };
}
export function evalDataset(cases = [evalCase()], fixtures = evalFixtures()) {
  return parseCases(YAML.stringify({ version: 2, fixtures, cases }), "unit-fixtures.yaml");
}
