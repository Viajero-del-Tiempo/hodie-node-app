import test from "node:test";
import assert from "node:assert/strict";
import YAML from "yaml";
import { parseCases } from "./eval/load-cases.js";
import { evalFixtures, evalCase, evalCart, evalDataset } from "./helpers/eval-fixtures.js";

test("lee YAML v2 y cuenta categorías sin fijar el tamaño del archivo del dueño", () => {
  const dataset = evalDataset([evalCase(), evalCase({ id: "EVAL-2", category: "other" })]);
  assert.deepEqual(dataset.errors, []);
  assert.equal(dataset.cases.length, 2);
  assert.deepEqual(dataset.categories, { example: 1, other: 1 });
  assert.match(dataset.hash, /^[a-f0-9]{64}$/);
});
test("informa sintaxis y claves YAML duplicadas con línea", () => {
  const broken = parseCases("version: 2\ncases: [\n");
  assert.ok(broken.errors.length);
  assert.ok(broken.errors[0].line >= 2);
  const duplicated = parseCases("version: 2\nversion: 2\n");
  assert.equal(duplicated.errors[0].line, 2);
});
test("versiones anteriores e IDs duplicados no pasan la validación", () => {
  assert.ok(parseCases(YAML.stringify({ version: 1, fixtures: evalFixtures(), cases: [evalCase()] })).errors.length);
  const duplicated = evalDataset([evalCase(), evalCase()]);
  assert.ok(duplicated.cases.every(item => item.diagnostics.some(issue => issue.code === "DUPLICATE_CASE_ID")));
});
test("una clave desconocida anidada bloquea solo su caso y señala la línea exacta", () => {
  const source = YAML.stringify({
    version: 2, fixtures: evalFixtures(), cases: [
      evalCase({ context: { carrito: evalCart({ envio: { desconocido: "valor" } }) } }),
      evalCase({ id: "EVAL-2" }),
    ],
  });
  const dataset = parseCases(source);
  const issue = dataset.cases[0].diagnostics.find(item => item.code === "UNKNOWN_CONTEXT_KEY");
  assert.equal(issue.line, source.split("\n").findIndex(line => line.includes("desconocido:")) + 1);
  assert.equal(issue.path, "cases[0].context.carrito.envio.desconocido");
  assert.deepEqual(dataset.cases[1].diagnostics, []);
});
test("rechaza referencias inexistentes y variantes de otro producto", () => {
  for (const [key, value, code] of [["producto", "missing", "UNKNOWN_PRODUCT"], ["variante", "missing", "UNKNOWN_VARIANT"], ["empaque", "missing", "UNKNOWN_PACKAGING"]]) {
    const cart = evalCart();
    cart.lineas[0][key] = value;
    assert.ok(evalDataset([evalCase({ context: { carrito: cart } })]).cases[0].diagnostics.some(issue => issue.code === code));
  }
  const fixtures = evalFixtures();
  fixtures.products.push({ ...structuredClone(fixtures.products[0]), id: "product-b",
    variants: [{ ...fixtures.products[0].variants[0], id: "variant-b" }] });
  const cart = evalCart();
  cart.lineas[0].variante = "variant-b";
  assert.ok(evalDataset([evalCase({ context: { carrito: cart } })], fixtures).cases[0].diagnostics.some(issue => issue.code === "UNKNOWN_VARIANT"));
});
test("no acepta texto libre, roles ambiguos ni herramientas desconocidas", () => {
  for (const context of ["carrito anterior", { conversacion: [{ cliente: "A", agente: "B" }] }, { pasoActual: "anterior" }]) {
    assert.ok(evalDataset([evalCase({ context })]).cases[0].diagnostics.length);
  }
  assert.ok(evalDataset([evalCase({ expect: { tools_called: ["not_a_tool"], handoff: "no" } })])
    .cases[0].diagnostics.some(issue => issue.code === "UNKNOWN_TOOL"));
});
