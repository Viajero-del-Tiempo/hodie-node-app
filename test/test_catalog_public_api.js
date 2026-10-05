import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createCatalogRouter } from "../src/routes/catalog.routes.js";
import { memoryCatalog, categoryFixture, productFixture, testId } from "./helpers/catalog-fixtures.js";

test("catálogo público: búsqueda, paginación, stock y detalle por slug sin Firebase", async t => {
  const category = categoryFixture({ name: "Categoría Alfa" });
  const disabledCategory = categoryFixture({ active: false });
  const products = Array.from({ length: 14 }, (_, index) => productFixture(category.id, {
    name: `Producto Alfa ${String(index).padStart(2, "0")}`, priceFrom: index + 1,
  }));
  products.forEach((product, index) => { product.variants[0].price = index + 1; });
  products[0].packagingOptions = [{ type: "opcion-libre", name: "Empaque Alfa", price: 3 }];
  products[0].variants[0].stock = 0;
  products.push(productFixture(category.id, { active: false }), productFixture(disabledCategory.id),
    productFixture(category.id, { schemaVersion: 1 }), productFixture(category.id, { variants: [] }));
  const catalog = memoryCatalog({ categories: [category, disabledCategory], products });
  const app = express();
  app.use("/catalog", createCatalogRouter(catalog.service));
  const server = await new Promise(resolve => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = async path => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/catalog${path}`);
    return { status: response.status, body: await response.json() };
  };

  assert.deepEqual((await request("/categories")).body.categories.map(item => item.id), [category.id]);
  const first = await request("/products");
  assert.equal(first.status, 200);
  assert.equal(first.body.total, 14);
  assert.equal(first.body.products.length, 12);
  assert.equal(first.body.products[0].variants[0].available, false);
  assert.deepEqual(first.body.products[0].optionNames, products[0].optionNames);
  assert.equal((await request("/products?page=2")).body.products.length, 2);
  assert.equal((await request("/products?sort=price-desc&pageSize=1")).body.products[0].variants[0].price, 14);
  assert.equal((await request("/products?onlyAvailable=true")).body.total, 13);
  assert.equal((await request("/products?query=producto%20alfa%20para%20pap%C3%A1")).body.total, 14);
  assert.equal((await request(`/products?categoryId=${disabledCategory.id}`)).body.total, 0);
  const detail = await request(`/products/by-slug/${products[0].slug}`);
  assert.equal(detail.body.product.id, products[0].id);
  assert.equal(detail.body.product.variants[0].available, false);
  assert.equal(detail.body.product.packagingOptions[0].name, "Empaque Alfa");
  assert.equal((await request(`/products/${products[0].id}`)).body.product.slug, products[0].slug);
  for (const product of products.slice(14)) assert.equal((await request(`/products/by-slug/${product.slug}`)).status, 404);
  assert.equal((await request(`/products/by-slug/${testId()}`)).status, 404);
  assert.equal((await request("/products/by-slug/ENLACE-ANTERIOR")).status, 404);
  for (const [query, field] of [["page=0", "page"], ["pageSize=101", "pageSize"], ["sort=invalid", "sort"],
    ["onlyAvailable=1", "onlyAvailable"], ["query=x&query=y", "query"]]) {
    const invalid = await request(`/products?${query}`);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.field, field);
  }
  catalog.data.products.push(productFixture(category.id, { slug: products[0].slug }));
  catalog.service.invalidateCache();
  assert.equal((await request(`/products/by-slug/${products[0].slug}`)).status, 404);
});
