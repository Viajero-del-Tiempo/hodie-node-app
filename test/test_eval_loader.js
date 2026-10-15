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
test("loader conserva imageUrls opcionales de variantes, incluidas URLs ficticias y lista vacía", () => {
  const fixtures = evalFixtures(); fixtures.products[0].variants[0].imageUrls = ["https://example.test/principal.png", "https://example.test/extra.png"];
  const dataset = evalDataset([evalCase()], fixtures);
  assert.deepEqual(dataset.errors, []); assert.deepEqual(dataset.cases[0].diagnostics, []);
  assert.deepEqual(dataset.fixtures.products[0].variants[0].imageUrls, fixtures.products[0].variants[0].imageUrls);
  fixtures.products[0].variants[0].imageUrls = []; assert.deepEqual(evalDataset([evalCase()], fixtures).errors, []);
  delete fixtures.products[0].variants[0].imageUrls; assert.deepEqual(evalDataset([evalCase()], fixtures).errors, []);
});
test("loader diagnostica imageUrls mal formadas con campo y línea, sin editar fixtures", () => {
  for (const urls of [null, "https://example.test/image.png", [null], ["no-url"], ["data:image/png;base64,AAAA"], [" https://example.test/a.png"]]) {
    const fixtures = evalFixtures(); fixtures.products[0].variants[0].imageUrls = urls;
    const source = YAML.stringify({ version: 2, fixtures, cases: [evalCase()] }); const dataset = parseCases(source);
    const issue = dataset.errors.find(error => error.path.startsWith("fixtures.products[0].variants[0].imageUrls"));
    assert.ok(issue); assert.ok(issue.line >= source.split("\n").findIndex(line => line.includes("imageUrls:")) + 1);
  }
});
test("loader acepta umbralCorporativo por caso sin cambiar el formato v2", () => {
  const dataset = evalDataset([
    evalCase({ context: { umbralCorporativo: 5 } }),
    evalCase({ id: "EVAL-2", context: { umbralCorporativo: 12,
      conversacion: [{ cliente: "Quiero una persona" }, { agente: "¿Te comunico?" }] } }),
    evalCase({ id: "EVAL-3" }),
  ]);
  assert.deepEqual(dataset.errors, []);
  assert.ok(dataset.cases.every(item => item.diagnostics.length === 0));
  assert.equal(dataset.cases[0].input.context.umbralCorporativo, 5);
  assert.equal(dataset.cases[1].input.context.umbralCorporativo, 12);
  assert.equal(dataset.cases[2].input.context, undefined);
});
test("fixtures de empaques conservan imagen opcional y diagnostican URL inválida con campo y línea", () => {
  const fixtures = evalFixtures(); fixtures.products[0].packagingOptions[0].imageUrl = "https://example.test/pack.png";
  const loaded = evalDataset([evalCase()], fixtures); assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.fixtures.products[0].packagingOptions[0].imageUrl, fixtures.products[0].packagingOptions[0].imageUrl);
  for (const value of ["", "/local-images/pack.png"]) {
    fixtures.products[0].packagingOptions[0].imageUrl = value; assert.deepEqual(evalDataset([evalCase()], fixtures).errors, []);
  }
  for (const value of [null, [], 5, "javascript:alert(1)", "data:image/png;base64,AAAA", "//example.test/a.png", "not-url"]) {
    fixtures.products[0].packagingOptions[0].imageUrl = value;
    const source = YAML.stringify({ version: 2, fixtures, cases: [evalCase()] }), dataset = parseCases(source);
    const diagnostic = dataset.errors.find(item => item.path === "fixtures.products[0].packagingOptions[0].imageUrl");
    assert.ok(diagnostic); assert.equal(diagnostic.line, source.split("\n").findIndex(line => line.includes("imageUrl:")) + 1);
  }
});
test("umbral inválido bloquea solo su caso con campo y línea, y no habilita otras claves", () => {
  for (const value of [null, 0, -1, 1.5, "5", true, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
    const source = YAML.stringify({ version: 2, fixtures: evalFixtures(), cases: [
      evalCase({ context: { umbralCorporativo: value } }), evalCase({ id: "EVAL-2" }),
    ] });
    const dataset = parseCases(source);
    assert.deepEqual(dataset.errors, []);
    const issue = dataset.cases[0].diagnostics.find(item => item.code === "INVALID_CONTEXT");
    assert.equal(issue?.path, "cases[0].context.umbralCorporativo");
    assert.equal(issue.line, source.split("\n").findIndex(line => line.includes("umbralCorporativo:")) + 1);
    assert.deepEqual(dataset.cases[1].diagnostics, []);
  }
  const dataset = evalDataset([evalCase({ context: { umbralCorporativo: 5, otroUmbral: 6 } })]);
  assert.ok(dataset.cases[0].diagnostics.some(issue => issue.code === "UNKNOWN_CONTEXT_KEY"
    && issue.path === "cases[0].context.otroUmbral"));
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
