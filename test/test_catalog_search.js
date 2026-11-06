import test from "node:test";
import assert from "node:assert/strict";
import { getQueryTerms, normalizeSearchText, matchSearchTerm, tokenizeSearchText } from "../src/utils/catalog-search.util.js";
import { categoryFixture, productFixture, memoryCatalog, syntheticSearchExample, testId } from "./helpers/catalog-fixtures.js";

test("normaliza acentos, diéresis, Unicode, puntuación y mayúsculas preservando ñ", () => {
  assert.equal(normalizeSearchText(" ÁÉÍÓÚ, Ü; Ñ "), "aeiou u ñ");
  assert.equal(normalizeSearchText("ACCIO\u0301N"), normalizeSearchText("acción"));
  assert.notEqual(normalizeSearchText("año"), normalizeSearchText("ano"));
  assert.deepEqual(getQueryTerms("Quiero buscar una acción para la acción"), ["accion"]);
  assert.deepEqual(getQueryTerms("busco algo para mi"), []);
});

test("plurales regulares funcionan en ambas direcciones sin diccionario del catálogo", () => {
  for (const [singular, plural] of [["acción", "acciones"], ["luz", "luces"], ["idea", "ideas"], ["árbol", "árboles"]]) {
    assert.equal(matchSearchTerm(normalizeSearchText(singular), tokenizeSearchText(plural)), 1);
    assert.equal(matchSearchTerm(normalizeSearchText(plural), tokenizeSearchText(singular)), 1);
    assert.equal(matchSearchTerm(normalizeSearchText(plural), tokenizeSearchText(plural)), 2);
  }
  assert.equal(matchSearchTerm("mes", ["m"]), 0);
});

test("consulta con datos ficticios devuelve coincidencia parcial sin etiqueta del destinatario", async () => {
  const example = syntheticSearchExample();
  const category = categoryFixture();
  const partial = productFixture(category.id, {
    name: example.productName, tags: [], optionNames: [example.optionName],
    variants: [{ id: testId(), sku: testId(), options: { [example.optionName]: example.optionValue }, price: 1, stock: 0, active: true }],
  });
  const complete = { ...partial, id: testId(), tags: [example.recipient] };
  const { service } = memoryCatalog({ categories: [category], products: [partial, complete] });
  const results = await service.searchProducts({ query: example.query });
  assert.deepEqual(results.map(product => product.id), [complete.id, partial.id]);
  assert.equal(results[0].matchedTerms.length, 4);
  assert.deepEqual(results[1].matchedTerms, ["producto", "alfa", "negro"]);
  assert.equal(results[1].variants[0].available, false);
  assert.equal(results[1].variants[0].price, 1);
});

test("cantidad de términos precede a relevancia y cada campo participa de la búsqueda", async () => {
  const term = testId().replaceAll("-", "").slice(-16);
  const other = testId().replaceAll("-", "").slice(-16);
  const categories = Array.from({ length: 5 }, () => categoryFixture());
  const products = categories.map(category => productFixture(category.id));
  products[0].name = `test-${term}`;
  products[1].tags = [term];
  categories[2].name = `test-${term}`;
  products[3].variants[0].options["test-axis"] = term;
  products[4].attributes["test-attribute"] = term;
  const { service } = memoryCatalog({ categories, products });
  const result = await service.searchProducts({ query: term, limit: 10 });
  assert.deepEqual(result.map(product => product.id), products.map(product => product.id));
  products[4].attributes["test-attribute"] = `${term} ${other}`;
  service.invalidateCache();
  assert.equal((await service.searchProducts({ query: `${term} ${other}` }))[0].id, products[4].id);
});

test("prioriza coincidencia exacta dentro del mismo campo y admite términos repartidos", async () => {
  const category = categoryFixture();
  const exact = productFixture(category.id, { tags: ["acciones"] });
  const plural = productFixture(category.id, { tags: ["acción"] });
  const { service } = memoryCatalog({ categories: [category], products: [plural, exact] });
  assert.deepEqual((await service.searchProducts({ query: "acciones" })).map(product => product.id), [exact.id, plural.id]);
  const token = testId().replaceAll("-", "").slice(-16);
  exact.attributes["test-attribute"] = token;
  service.invalidateCache();
  assert.deepEqual((await service.searchProducts({ query: `acciones ${token}` }))[0].matchedTerms, ["acciones", token]);
});

test("agotados visibles por defecto; filtros de categoría, disponibilidad y opciones", async () => {
  const category = categoryFixture();
  const product = productFixture(category.id);
  const first = product.variants[0];
  const second = { ...first, id: testId(), sku: testId(), options: { "test-axis": testId() }, stock: 0, price: 2 };
  product.variants.push(second, { ...first, id: testId(), sku: testId(), options: { "test-axis": testId() }, active: false });
  const inactive = productFixture(category.id, { active: false });
  const noVariants = productFixture(category.id, { variants: [{ ...first, active: false }] });
  const disabledCategory = categoryFixture({ active: false });
  const legacy = { ...productFixture(category.id), schemaVersion: 1 };
  const { service } = memoryCatalog({ categories: [category, disabledCategory], products: [product, inactive, noVariants, legacy, productFixture(disabledCategory.id)] });
  const results = await service.searchProducts();
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].variants.map(variant => variant.available), [true, false]);
  assert.equal((await service.searchProducts({ onlyAvailable: true }))[0].variants.length, 1);
  const option = await service.searchProducts({ options: { "test-axis": second.options["test-axis"].toUpperCase() } });
  assert.deepEqual(option[0].variants.map(variant => variant.id), [second.id]);
  assert.deepEqual(await service.searchProducts({ onlyAvailable: true, options: { "test-axis": second.options["test-axis"] } }), []);
  assert.deepEqual(await service.searchProducts({ options: { "test-other-axis": first.options["test-axis"] } }), []);
  assert.deepEqual(await service.searchProducts({ categoryId: testId() }), []);
});

test("no combina términos o filtros de opciones de variantes distintas", async () => {
  const category = categoryFixture();
  const a = testId().replaceAll("-", "");
  const b = testId().replaceAll("-", "");
  const product = productFixture(category.id, { optionNames: ["test-a", "test-b"] });
  product.variants = [
    { id: testId(), sku: testId(), price: 1, stock: 1, active: true, options: { "test-a": a, "test-b": testId() } },
    { id: testId(), sku: testId(), price: 1, stock: 1, active: true, options: { "test-a": testId(), "test-b": b } },
  ];
  const { service } = memoryCatalog({ categories: [category], products: [product] });
  assert.equal((await service.searchProducts({ query: `${a} ${b}` }))[0].matchedTerms.length, 1);
  assert.deepEqual(await service.searchProducts({ options: { "test-a": a, "test-b": b } }), []);
});

test("orden estable, límite predeterminado, consulta vacía y ausencia de resultados", async () => {
  const category = categoryFixture();
  const products = Array.from({ length: 7 }, () => productFixture(category.id)).sort((a, b) => a.name.localeCompare(b.name));
  const { service } = memoryCatalog({ categories: [category], products: [...products].reverse() });
  const result = await service.searchProducts();
  assert.equal(result.length, 5);
  assert.deepEqual(result.map(product => product.id), products.slice(0, 5).map(product => product.id));
  assert.deepEqual(result[0].matchedTerms, []);
  assert.equal((await service.searchProducts({ query: "quiero ver" })).length, 5);
  assert.equal((await service.searchProducts({ limit: 1 })).length, 1);
  assert.deepEqual(await service.searchProducts({ query: testId().replaceAll("-", "") }), []);
});

test("argumentos de búsqueda inválidos indican el campo", async () => {
  const { service } = memoryCatalog();
  for (const [input, field] of [[{ query: 1 }, "query"], [{ limit: 0 }, "limit"], [{ limit: 1.5 }, "limit"], [{ onlyAvailable: "false" }, "onlyAvailable"], [{ options: [] }, "options"], [{ options: { x: "" } }, "options"], [{ categoryId: "a/b" }, "categoryId"], [{ categoryId: " test-id " }, "categoryId"]]) {
    await assert.rejects(service.searchProducts(input), error => error.status === 400 && error.field === field);
  }
});
