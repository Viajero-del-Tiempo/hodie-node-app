import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { consultationFixture } from "./helpers/consultation-fixtures.js";
import { evalFixtures, evalCart } from "./helpers/eval-fixtures.js";
import { CONSULTATION_TOOL_NAMES, createToolRegistry } from "../src/agents/consultation/tool-registry.js";
import { TOOL_NAMES, checkToolSpecification } from "./eval/tool-names.js";
import { deterministicChecks } from "./eval/checks.js";

test("registro de consulta es subconjunto canónico y coincide con la especificación", async () => {
  assert.deepEqual(CONSULTATION_TOOL_NAMES, ["buscar_productos", "ver_producto", "enviar_imagenes", "consultar_politicas", "estado_pedido", "responder"]);
  assert.ok(CONSULTATION_TOOL_NAMES.every(name => TOOL_NAMES.includes(name)));
  assert.equal(checkToolSpecification(await readFile(new URL("../docs/SPEC-agente.md", import.meta.url), "utf8")).valid, true);
});
test("búsqueda usa catálogo central, coincidencias parciales y agotados visibles por defecto", async () => {
  const fixtures = evalFixtures();
  fixtures.products[0].variants[0].stock = 0;
  const f = await consultationFixture({ fixtures });
  try {
    const result = await f.world.invokeTool("buscar_productos", { consulta: "Productos Alfa para papá" });
    assert.equal(result.code, "OK");
    assert.equal(result.products.length, 1);
    assert.ok(result.products[0].matchedTerms.includes("alfa"));
    assert.equal(result.products[0].variants[0].available, false);
    assert.equal(result.products[0].priceFrom, 100);
    assert.equal((await f.world.invokeTool("buscar_productos", { consulta: "Alfa", soloDisponibles: true })).products.length, 0);
  } finally { f.close(); }
});
test("detalle conserva atributos, IDs, empaques libres y sus precios sin inventar datos", async () => {
  const fixtures = evalFixtures();
  fixtures.products[0].attributes = { material: "Material ficticio Gamma" };
  fixtures.products[0].packagingOptions.push({ type: "pack-z", name: "Empaque Zeta", price: 17 });
  const f = await consultationFixture({ fixtures });
  try {
    const result = await f.world.invokeTool("ver_producto", { productId: "product-a" });
    assert.equal(result.product.attributes.material, "Material ficticio Gamma");
    assert.deepEqual(result.product.packagingOptions, fixtures.products[0].packagingOptions);
    assert.equal(result.product.variants[0].id, "variant-a");
    assert.equal((await f.world.invokeTool("ver_producto", { productId: "missing" })).code, "PRODUCTO_NO_ENCONTRADO");
  } finally { f.close(); }
});
test("productos y categorías inactivos y variantes inactivas no se publican", async () => {
  for (const change of [data => { data.products[0].active = false; }, data => { data.categories[0].active = false; },
    data => { data.products[0].variants[0].active = false; }]) {
    const fixtures = evalFixtures(); change(fixtures);
    const f = await consultationFixture({ fixtures });
    try {
      assert.equal((await f.world.invokeTool("ver_producto", { productId: "product-a" })).code, "PRODUCTO_NO_ENCONTRADO");
      assert.deepEqual((await f.world.invokeTool("buscar_productos", { consulta: "Alfa" })).products, []);
    } finally { f.close(); }
  }
});
test("imágenes usa solo URLs existentes, prioriza variante, elimina duplicados y envía hasta tres", async () => {
  const fixtures = evalFixtures();
  fixtures.products[0].imageUrls = ["https://example.test/a.png", "https://example.test/b.png", "https://example.test/c.png", "https://example.test/d.png"];
  fixtures.products[0].variants[0].imageUrls = ["https://example.test/c.png", "https://example.test/a.png"];
  const f = await consultationFixture({ fixtures });
  try {
    const result = await f.world.invokeTool("enviar_imagenes", { productId: "product-a", variantId: "variant-a" });
    assert.deepEqual(result, { code: "OK", sent: 3 });
    assert.deepEqual(f.transport.getOutgoing().map(message => message.source), ["https://example.test/c.png", "https://example.test/a.png", "https://example.test/b.png"]);
    assert.equal((await f.world.invokeTool("enviar_imagenes", { productId: "product-a", variantId: "missing" })).sent, 0);
    assert.equal(f.transport.getOutgoing().length, 3);
  } finally { f.close(); }
});
test("sin fotos no se envía nada ni se inventa una imagen", async () => {
  const f = await consultationFixture();
  try {
    assert.deepEqual(await f.world.invokeTool("enviar_imagenes", { productId: "product-a" }), { code: "SIN_IMAGENES", sent: 0 });
    assert.deepEqual(f.transport.getOutgoing(), []);
  } finally { f.close(); }
});
test("políticas se leen por temas libres y cambian con los fixtures", async () => {
  const fixtures = evalFixtures();
  fixtures.policies = { tema_imprevisto: "Texto de política inventado para esta prueba." };
  const f = await consultationFixture({ fixtures });
  try {
    assert.deepEqual((await f.world.invokeTool("consultar_politicas", {})).policies,
      [{ id: "tema_imprevisto", title: "tema_imprevisto", text: fixtures.policies.tema_imprevisto }]);
  } finally { f.close(); }
});
test("argumentos inválidos quedan registrados sin ejecutar efectos ni borrar el carrito", async () => {
  const f = await consultationFixture({ context: { carrito: evalCart() } });
  try {
    const before = f.world.snapshot();
    for (const [name, args, field] of [
      ["buscar_productos", { consulta: "Alfa", limite: 6 }, "limite"],
      ["ver_producto", { productId: "../other" }, "productId"],
      ["enviar_imagenes", { productId: "product-a", source: "https://example.test/inventada.png" }, "source"],
      ["estado_pedido", { phoneVerified: true }, "phoneVerified"],
      ["responder", { texto: "Respuesta" }, "entendido"],
    ]) {
      const result = await f.world.invokeTool(name, args);
      assert.equal(result.code, "ARGUMENTOS_INVALIDOS"); assert.equal(result.field, field);
    }
    for (const name of ["derivar", "carrito_quitar", "crear_pedido", "__proto__", "modificar_precio"]) {
      assert.equal((await f.world.invokeTool(name, {})).code, "HERRAMIENTA_NO_DISPONIBLE");
    }
    assert.equal((await f.world.invokeTool("responder", { texto: "Respuesta", entendido: true, quoteIdMostrado: "inventado" })).code, "FUNCION_NO_DISPONIBLE");
    assert.deepEqual(f.world.snapshot(), before);
    assert.deepEqual(f.transport.getOutgoing(), []);
    assert.equal(f.world.getEvents().length, 11);
  } finally { f.close(); }
});
test("esquema del proveedor aprende ejes del catálogo y no anuncia funciones futuras", () => {
  const registry = createToolRegistry({});
  const initial = registry.definitions()[0].functionDeclarations;
  assert.equal(initial.find(tool => tool.name === "buscar_productos").parameters.properties.opciones, undefined);
  const dynamic = registry.definitions({ optionNames: ["ejeInventado"] })[0].functionDeclarations;
  assert.deepEqual(Object.keys(dynamic.find(tool => tool.name === "buscar_productos").parameters.properties.opciones.properties), ["ejeInventado"]);
  assert.equal(dynamic.find(tool => tool.name === "responder").parameters.properties.quoteIdMostrado, undefined);
  assert.deepEqual(registry.definitions({ onlyTerminal: true })[0].functionDeclarations.map(tool => tool.name), ["responder"]);
});
test("un intento bloqueado no acredita una herramienta requerida, pero sí detecta un intento prohibido", async () => {
  const f = await consultationFixture();
  try {
    f.world.beginTurn(1, new AbortController().signal);
    await f.world.invokeTool("derivar", { motivo: "No disponible todavía" });
    const tools = f.world.getEvents();
    assert.equal(tools[0].handlerInvoked, false);
    const checks = deterministicChecks({ tools_called: ["derivar"], tools_not_called: ["derivar"], handoff: "no" }, {
      tools, turns: [], finalHandoff: false,
    });
    assert.equal(checks.find(check => check.kind === "tools_called").pass, false);
    assert.equal(checks.find(check => check.kind === "tools_not_called").pass, false);
    assert.equal(f.world.getState().humanHandoffRequired, false);
  } finally { f.close(); }
});
