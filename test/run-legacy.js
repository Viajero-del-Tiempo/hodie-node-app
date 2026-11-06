import "./firebase-bootstrap.js";
import { readFile } from "node:fs/promises";
import { parse } from "dotenv";
import { requireTestFirestore } from "../src/config/firebase-test-environment.js";
import { runIsolatedEmulatorSuite } from "./emulator-suite.js";

requireTestFirestore(); // Antes de leer .env, importar SDKs o iniciar una suite.
const env = { ...process.env };
let settings = {};
try { settings = parse(await readFile(new URL("../.env", import.meta.url))); } catch (error) { if (error.code !== "ENOENT") throw error; }
for (const key of ["GEMINI_API_KEY", "GEMINI_MODEL", "GOOGLE_API_KEY"]) if (env[key] === undefined && settings[key] !== undefined) env[key] = settings[key];
const suites = ["budget_agent_v2", "handoff_alert_transition", "lid_resolution", "order_pdf_decoupling", "multi_agent_graph", "bot_resume_and_filters"];
let failed = false;
for (const name of suites) {
  if (await runIsolatedEmulatorSuite(`test/test_${name}.js`, { env, seedLegacy: true }) !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
