import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isFirebaseTestProcess, requireTestFirestore } from "../src/config/firebase-test-environment.js";
import { parseInventoryArgs, readOnlyFirestore, listTestDocuments, documentMatches } from "../scripts/lib/test-order-inventory.js";

const cwd = fileURLToPath(new URL("../", import.meta.url));
function probe(args, overrides = {}) {
  const env = { ...process.env, ALLOW_PROD_FIRESTORE_TESTS: "1", HODIE_TEST_MODE: "1", FIREBASE_SERVICE_ACCOUNT_PATH: "/no-leer-credenciales.json",
    DOTENV_CONFIG_PATH: fileURLToPath(new URL("../scripts/emulator.env", import.meta.url)), ...overrides };
  for (const key of ["FIRESTORE_EMULATOR_HOST", "GCLOUD_PROJECT", "CATALOG_TEST_PROJECT_ID"]) if (overrides[key] === undefined) delete env[key];
  return spawnSync(process.execPath, args, { cwd, env, encoding: "utf8", timeout: 15000 });
}

test("guarda común: nunca autoriza producción; exige host local, proyecto demo y elimina descubrimiento de credenciales", () => {
  assert.throws(() => requireTestFirestore({ ALLOW_PROD_FIRESTORE_TESTS: "1" }), { code: "TEST_FIRESTORE_EMULATOR_REQUIRED" });
  for (const host of ["firestore.googleapis.com:443", "localhost", "127.0.0.1:0", "127.0.0.1:65536", "localhost:8080/"]) {
    assert.throws(() => requireTestFirestore({ FIRESTORE_EMULATOR_HOST: host }));
  }
  assert.throws(() => requireTestFirestore({ FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", GCLOUD_PROJECT: "hodie-tienda-de-regalos" }));
  const env = { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", GOOGLE_APPLICATION_CREDENTIALS: "privado.json", FIREBASE_SERVICE_ACCOUNT_PATH: "privado.json", FIREBASE_CONFIG_BASE64: "no-leer" };
  assert.deepEqual(requireTestFirestore(env), { host: "127.0.0.1:8080", projectId: "demo-hodie-catalogo" });
  for (const key of ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_SERVICE_ACCOUNT_PATH", "FIREBASE_CONFIG_BASE64"]) assert.equal(Object.hasOwn(env, key), false);
  assert.equal(isFirebaseTestProcess({}, ["node", "/workspace/test/test_any.js"]), true);
  assert.equal(isFirebaseTestProcess({}, ["node", "/workspace/scripts/list-test-orders.js"]), false);
});

test("preload y acceso directo al inicializador fallan antes de credenciales aunque ALLOW_PROD=1", () => {
  for (const args of [["--import", "./test/firebase-bootstrap.js", "--input-type=module", "-e", "await import('firebase-admin/app')"],
    ["--input-type=module", "-e", "await import('./src/config/firebase.js')"],
    ["--input-type=module", "-e", "await (await import('./test/helpers/catalog-firestore.js')).openCatalogTestFirestore()"]]) {
    const result = probe(args);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /falta FIRESTORE_EMULATOR_HOST/);
    assert.equal(result.stdout.includes("Firebase Admin inicializado"), false);
    assert.equal(result.stderr.includes("ENOENT"), false);
  }
});

test("los ocho antiguos rechazan el arranque sin emulador, incluidos sus imports ESM", () => {
  for (const name of ["budget_agent_v2", "handoff_alert_transition", "lid_resolution", "order_pdf_decoupling", "order_security", "whatsapp_chat_id", "multi_agent_graph", "bot_resume_and_filters"]) {
    const result = probe(["test/test_" + name + ".js"]);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /falta FIRESTORE_EMULATOR_HOST/, name);
    assert.equal(result.stdout.includes("Firebase Admin inicializado"), false);
    assert.equal(result.stdout.includes("BATERÍA"), false);
  }
});

test("incluso con emulador el SDK de tests rechaza cert, ADC y opciones de producción antes de inicializar una app", () => {
  for (const expression of ["cert({})", "applicationDefault()", "initializeApp({projectId:'produccion'})", "initializeApp({credential:{}})"]) {
    const result = probe(["--import", "./test/firebase-bootstrap.js", "--input-type=module", "-e",
      `import { cert, applicationDefault, initializeApp, getApps } from 'firebase-admin/app'; try { ${expression}; process.exitCode=1; } catch (error) { console.log(error.message); console.log(getApps().length); }`],
      { FIRESTORE_EMULATOR_HOST: "127.0.0.1:1", GCLOUD_PROJECT: "demo-hodie-catalogo" });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /prohibid|no puede/); assert.match(result.stdout, /\n0\n$/);
  }
});

function fakeReadDatabase(rows) {
  const snap = path => ({ id: path.split("/").at(-1), ref: { path, delete: () => assert.fail("No borrar") }, exists: rows.has(path), data: () => rows.get(path) });
  const field = (data, path) => path.split(".").reduce((value, key) => value?.[key], data);
  const query = (paths, filters = [], limit = Infinity) => ({
    where: (key, _op, value) => query(paths, [...filters, data => field(data, key) === value], limit),
    orderBy: () => query(paths, filters, limit), limit: count => query(paths, filters, count),
    async get() { return { docs: paths.filter(path => filters.every(check => check(rows.get(path)))).slice(0, limit).map(snap) }; },
  });
  return { collection: name => query([...rows.keys()].filter(path => path.split("/").length === name.split("/").length + 1 && path.startsWith(name + "/"))),
    collectionGroup: name => query([...rows.keys()].filter(path => path.split("/").at(-2) === name)),
    doc: path => ({ get: async () => snap(path), set: () => assert.fail("No escribir") }),
    batch: () => assert.fail("No crear batch"), runTransaction: () => assert.fail("No abrir transacción") };
}

test("inventario solo lectura: teléfono, documentos relacionados, checkpoints, marcas/fechas y contador sin modificar", async () => {
  const phone = "595981646055", date = "2026-10-18T12:00:00Z";
  const rows = new Map([
    ["orders/random-id", { orderNumber: "hodie000843", userId: "test-u", userPhoneNumber: phone, whatsappChatId: "test-lid@lid", createdAt: date, items: [{ productId: "test-p" }] }],
    ["orders/legitimate", { userPhoneNumber: "595900000002", createdAt: "2020-01-01T00:00:00Z", items: [] }],
    ["users/test-u", { phoneNumber: phone }], ["products/test-p", { name: "Producto ficticio" }],
    ["langgraph_checkpoint_writes/write", { thread_id: "test-lid@lid" }],
    ["langgraph_checkpoints/test-lid@lid/checkpoints/one", { thread_id: "test-lid@lid" }],
    ["counters/orderNumber", { lastOrderNumber: 852 }],
  ]);
  const before = structuredClone(rows), output = [], db = readOnlyFirestore(fakeReadDatabase(rows));
  assert.equal(db.runTransaction, undefined); assert.equal(db.batch, undefined); assert.equal(db.doc("orders/random-id").set, undefined);
  const docs = await db.collection("orders").get(); assert.equal(docs.docs[0].ref.delete, undefined);
  const summary = await listTestDocuments(db, parseInventoryArgs([]), { emit: row => output.push(row) });
  for (const path of ["orders/random-id", "users/test-u", "products/test-p", "langgraph_checkpoint_writes/write", "langgraph_checkpoints/test-lid@lid/checkpoints/one"]) assert.ok(output.some(row => row.path === path), path);
  assert.equal(output.some(row => row.path === "orders/legitimate"), false);
  assert.equal(summary.counter.lastOrderNumber, 852); assert.deepEqual(rows, before);
  const options = parseInventoryArgs(["--marker", "test-", "--from", "2026-10-18T00:00:00Z", "--to", "2026-10-19T00:00:00Z"]);
  assert.equal(options.phones.length, 0);
  const matched = documentMatches({ id: "sample", ref: { path: "orders/sample" }, data: () => ({ createdAt: date, userId: "test-u" }) }, options);
  assert.ok(matched.includes("fecha:createdAt")); assert.ok(matched.includes("marca:userId"));
  assert.throws(() => parseInventoryArgs(["--from", "2026-10-18"]));
  assert.throws(() => parseInventoryArgs(["--delete", "yes"]));
  const partial = await listTestDocuments(db, parseInventoryArgs(["--marker", "test-", "--limit", "1"]));
  assert.equal(partial.complete, false); assert.ok(partial.truncatedQueries.length);
});

test("inventario informa consultas fallidas sin presentar el listado parcial como completo", async () => {
  const rows = new Map([["orders/sample", { userPhoneNumber: "595981646055" }]]);
  const raw = fakeReadDatabase(rows), baseCollection = raw.collection;
  raw.collection = name => name === "users" ? { where() { return this; }, limit() { return this; },
    get: async () => { throw Object.assign(new Error("Lectura denegada"), { code: 7 }); } } : baseCollection(name);
  const output = [];
  const summary = await listTestDocuments(readOnlyFirestore(raw), parseInventoryArgs([]), { emit: row => output.push(row) });
  assert.equal(summary.complete, false);
  assert.ok(summary.failedQueries.some(failure => failure.query.startsWith("users:") && failure.code === 7));
  assert.ok(output.some(row => row.path === "orders/sample"));
});
