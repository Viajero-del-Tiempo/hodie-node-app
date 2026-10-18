import { spawn } from "node:child_process";
import { runIsolatedEmulatorSuite } from "../test/emulator-suite.js";
import { makeLocalEnvironment, assertLocalEnvironment, assertLocalCatalogTarget, localCatalog, projectDirectory } from "./local-catalog.config.js";

assertLocalCatalogTarget(process.env);
const env = makeLocalEnvironment();
assertLocalEnvironment(env);
// Reutiliza el emulador levantado por catalog:local. No lo borra ni lo detiene.
const response = await fetch("http://127.0.0.1:4400/emulators", { signal: AbortSignal.timeout(2000) })
  .catch(() => { throw new Error("Levantá primero npm run catalog:local"); });
const emulators = await response.json();
if (emulators.firestore?.port !== localCatalog.firestorePort) throw new Error("No está disponible el emulador local esperado");
const customerTests = ["test/test_profile_api.js", "test/test_customer_orders_api.js", "test/test_checkout_customer_data_api.js"];
const agentTests = ["test/test_agent_order_transactions.js"];
const receiptTests = ["test/test_receipt_transactions.js"];
const supportTests = ["test/test_agent_support_transactions.js", ...agentTests, ...receiptTests];
const whatsappTests = ["test/test_whatsapp_delivery_emulator.js", "test/test_whatsapp_control_emulator.js"];
const legacyIntegrationTests = ["test/test_order_security.js", "test/test_whatsapp_chat_id.js"];
const isolatedOnly = process.argv.includes("--legacy-orders-only");
const tests = isolatedOnly ? [] : process.argv.includes("--agent-whatsapp-only") ? whatsappTests : process.argv.includes("--agent-receipts-only") ? receiptTests : process.argv.includes("--agent-support-only") ? supportTests : process.argv.includes("--agent-orders-only") ? agentTests : process.argv.includes("--customer-only") ? customerTests : [
  "test/test_catalog_crud.js", "test/test_catalog_admin_api.js", "test/test_catalog_products_api.js",
  "test/test_order_variant_orders.js", "test/test_order_variant_transactions.js",
  ...customerTests,
  ...supportTests,
  ...whatsappTests,
];
let anyFailed = tests.length ? await new Promise(resolve => {
  const child = spawn(process.execPath, ["--import", "./test/firebase-bootstrap.js", "--test", ...tests], { cwd: projectDirectory, env, stdio: "inherit" });
  child.once("error", error => { console.error(error.message); resolve(true); });
  child.once("exit", code => resolve(code !== 0));
}) : false;
if (isolatedOnly || !process.argv.some(value => value.endsWith("-only"))) {
  for (const file of legacyIntegrationTests) if (await runIsolatedEmulatorSuite(file, { env }) !== 0) anyFailed = true;
}
process.exitCode = anyFailed ? 1 : 0;
