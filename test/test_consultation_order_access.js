import test from "node:test";
import assert from "node:assert/strict";
import { consultationFixture } from "./helpers/consultation-fixtures.js";
import { evalFixtures } from "./helpers/eval-fixtures.js";

test("teléfono verificado y pedido propio devuelve estado y productos, sin datos privados", async () => {
  const fixtures = evalFixtures();
  Object.assign(fixtures.orders[0], { shippingAddress: { street: "Dato privado" }, billing: { ruc: "1234567-9" }, secret: "INTERNAL_SENTINEL" });
  const f = await consultationFixture({ fixtures, context: { telefonoCliente: "595900000001" } });
  try {
    const result = await f.world.invokeTool("estado_pedido", { orderNumber: "test-order-a", phone: "0999999999" });
    assert.equal(result.order.status, "pending");
    assert.equal(result.order.items[0].productName, "Producto Alfa");
    assert.deepEqual(Object.keys(result.order).sort(), ["items", "orderNumber", "status"]);
    assert.equal(JSON.stringify(result).includes("INTERNAL_SENTINEL"), false);
    assert.equal((await f.world.invokeTool("estado_pedido", {})).order.orderNumber, "test-order-a");
  } finally { f.close(); }
});
test("sin verificar exige número y teléfono coincidentes y devuelve exclusivamente el estado", async () => {
  const f = await consultationFixture();
  try {
    assert.deepEqual((await f.world.invokeTool("estado_pedido", {})).fields, ["orderNumber", "phone"]);
    assert.deepEqual((await f.world.invokeTool("estado_pedido", { orderNumber: "test-order-a" })).fields, ["phone"]);
    const result = await f.world.invokeTool("estado_pedido", { orderNumber: "test-order-a", phone: "0900000001" });
    assert.deepEqual(result, { code: "OK", order: { orderNumber: "test-order-a", status: "pending" } });
    assert.equal(f.world.getState().phoneVerified, false);
    assert.equal(f.world.getState().userPhoneNumber, null);
  } finally { f.close(); }
});
test("SEC-03: identidad verificada ajena exige teléfono de compra y permite solo estado si coincide", async () => {
  const f = await consultationFixture({ context: { telefonoCliente: "595900000002" } });
  try {
    assert.deepEqual((await f.world.invokeTool("estado_pedido", { orderNumber: "test-order-a" })).fields, ["phone"]);
    const wrong = await f.world.invokeTool("estado_pedido", { orderNumber: "test-order-a", phone: "0900000002" });
    assert.equal(wrong.code, "PEDIDO_NO_ENCONTRADO");
    assert.equal(wrong.order, undefined);
    const result = await f.world.invokeTool("estado_pedido", { orderNumber: "test-order-a", phone: "+595 900 000 001" });
    assert.deepEqual(result, { code: "OK", order: { orderNumber: "test-order-a", status: "pending" } });
    assert.equal(result.order.items, undefined);
    assert.equal(f.world.getState().phoneVerified, true);
    assert.equal(f.world.getState().userPhoneNumber, "595900000002");
  } finally { f.close(); }
});
test("número inexistente, teléfono incorrecto o inválido producen la misma respuesta genérica", async () => {
  for (const context of [{}, { telefonoCliente: "595900000002" }]) {
    const f = await consultationFixture({ context });
    try {
      const inputs = [{ orderNumber: "missing", phone: "0900000001" }, { orderNumber: "test-order-a", phone: "0900000002" },
        { orderNumber: "test-order-a", phone: "not-a-phone" }];
      const results = await Promise.all(inputs.map(args => f.world.invokeTool("estado_pedido", args)));
      assert.deepEqual(results[0], results[1]); assert.deepEqual(results[1], results[2]);
      assert.deepEqual(results[0], { code: "PEDIDO_NO_ENCONTRADO", message: "No encontramos un pedido con esos datos." });
    } finally { f.close(); }
  }
});
test("varios pedidos propios sin fechas piden número, sin inferir cuál es el más reciente", async () => {
  const fixtures = evalFixtures();
  fixtures.orders.push({ ...fixtures.orders[0], orderNumber: "test-order-z", status: "shipped" });
  fixtures.orders.push({ ...fixtures.orders[0], orderNumber: "test-other", userPhoneNumber: "595900000002" });
  const f = await consultationFixture({ fixtures, context: { telefonoCliente: "595900000001" } });
  try {
    const result = await f.world.invokeTool("estado_pedido", {});
    assert.equal(result.code, "DATO_FALTANTE");
    assert.deepEqual(result.fields, ["orderNumber"]);
    assert.deepEqual(result.orders.map(order => order.orderNumber), ["test-order-a", "test-order-z"]);
    assert.ok(result.orders.every(order => Object.keys(order).length === 2));
  } finally { f.close(); }
});
test("un LID o un teléfono escrito en el estado no se trata como identidad verificada", async () => {
  const f = await consultationFixture();
  try {
    const state = f.world.getState();
    state.userPhoneNumber = "595900000001"; state.phoneVerified = false;
    f.world.setState(state);
    assert.deepEqual((await f.world.invokeTool("estado_pedido", {})).fields, ["orderNumber", "phone"]);
    state.userPhoneNumber = "595900000001@lid"; state.phoneVerified = true; f.world.setState(state);
    assert.deepEqual((await f.world.invokeTool("estado_pedido", {})).fields, ["orderNumber", "phone"]);
  } finally { f.close(); }
});
