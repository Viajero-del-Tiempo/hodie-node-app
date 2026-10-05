import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
const memorySuites = [
  "test/test_catalog_search.js",
  "test/test_catalog_validation.js",
  "test/test_catalog_service.js",
  "test/test_catalog_public_api.js",
  "test/test_order_variant_pricing.js",
  "test/test_order_variant_stock.js",
];
const existingSuites = [
  "test/test_budget_agent_v2.js",
  "test/test_handoff_alert_transition.js",
  "test/test_lid_resolution.js",
  "test/test_order_pdf_decoupling.js",
  "test/test_order_security.js",
  "test/test_whatsapp_chat_id.js",
  "test/test_multi_agent_graph.js",
  "test/test_bot_resume_and_filters.js",
];
const suites = [
  ...memorySuites.map(file => ({ file, args: ["--test", file], env: process.env })),
  ...existingSuites.map(file => ({ file, args: [file], env: { ...process.env, ALLOW_PROD_FIRESTORE_TESTS: "1" } })),
];

let anyFailed = false;
// Secuenciales y en procesos separados: los mocks de una suite no afectan otra.
// Se conserva la salida real de cada proceso, sin capturarla ni reconstruirla.
for (const suite of suites) {
  console.log(`\n=== ${suite.file} ===`);
  const result = spawnSync(process.execPath, suite.args, {
    cwd: projectDirectory, env: suite.env, stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    anyFailed = true;
    if (result.error) console.error(`No se pudo ejecutar ${suite.file}:`, result.error);
    else console.error(`${suite.file} terminó con ${result.signal ? `señal ${result.signal}` : `código ${result.status}`}.`);
  }
}
process.exitCode = anyFailed ? 1 : 0;
