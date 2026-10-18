import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
const memorySuites = [
  "test/test_firestore_safety.js",
  "test/test_whatsapp_human_control.js",
  "test/test_whatsapp_alert_dispatcher.js",
  "test/test_admin_agent_chats.js",
  "test/test_whatsapp_agent_routing.js",
  "test/test_whatsapp_transport.js",
  "test/test_whatsapp_production.js",
  "test/test_receipt_retention.js",
  "test/test_agent_packaging_images.js",
  "test/test_agent_packaging_images_runner.js",
  "test/test_catalog_packaging_images.js",
  "test/test_agent_product_images.js",
  "test/test_agent_product_images_runner.js",
  "test/test_agent_receipts.js",
  "test/test_receipt_media_storage.js",
  "test/test_receipt_runner.js",
  "test/test_agent_config.js",
  "test/test_agent_alerts.js",
  "test/test_agent_handoff.js",
  "test/test_agent_corporate_quantity.js",
  "test/test_agent_support_runner.js",
  "test/test_agent_cart.js",
  "test/test_agent_customer_data.js",
  "test/test_agent_quotes.js",
  "test/test_agent_purchase_runner.js",
  "test/test_agent_checkout_contract.js",
  "test/test_agent_order_confirmation.js",
  "test/test_agent_order_creation.js",
  "test/test_agent_order_pdf_jobs.js",
  "test/test_agent_model_invoker.js",
  "test/test_guardian_filters.js",
  "test/test_guardian_bursts.js",
  "test/test_guardian_sessions.js",
  "test/test_guardian_limits.js",
  "test/test_guardian_media.js",
  "test/test_guardian_runtime.js",
  "test/test_guardian_whatsapp_adapter.js",
  "test/test_consultation_tools.js",
  "test/test_consultation_order_access.js",
  "test/test_consultation_agent.js",
  "test/test_consultation_runner.js",
  "test/test_eval_model_usage.js",
  "test/test_eval_loader.js",
  "test/test_eval_context.js",
  "test/test_eval_transport.js",
  "test/test_eval_checks.js",
  "test/test_eval_judge.js",
  "test/test_eval_runner.js",
  "test/test_ruc_validation.js",
  "test/test_profile_validation.js",
  "test/test_order_customer_data.js",
  "test/test_order_billing_pdf.js",
  "test/test_catalog_search.js",
  "test/test_catalog_validation.js",
  "test/test_catalog_service.js",
  "test/test_catalog_public_api.js",
  "test/test_auth_endpoints.js",
  "test/test_catalog_admin_contract.js",
  "test/test_catalog_images.js",
  "test/test_order_variant_pricing.js",
  "test/test_order_variant_stock.js",
];
const suites = memorySuites.map(file => ({ file, args: ["--import", "./test/firebase-bootstrap.js", "--test", file], env: process.env }));

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
