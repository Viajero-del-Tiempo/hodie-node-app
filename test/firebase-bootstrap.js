import { registerHooks } from "node:module";
import { requireTestFirestore } from "../src/config/firebase-test-environment.js";

// Preload antes de enlazar los imports ESM de las suites. No carga Firebase.
process.env.HODIE_TEST_MODE = "1";
const guardURL = new URL("../src/config/firebase-test-environment.js", import.meta.url).href;
const firebaseURL = new URL("../src/config/firebase.js", import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  const sdk = specifier === "firebase-admin" || specifier.startsWith("firebase-admin/") || specifier.startsWith("@google-cloud/firestore");
  if (sdk) requireTestFirestore();
  const result = nextResolve(specifier, context);
  if (result.url === firebaseURL) requireTestFirestore();
  if (specifier === "firebase-admin") throw new Error("Tests: usar firebase-admin/app mediante el inicializador común, sin credenciales");
  if (specifier !== "firebase-admin/app") return result;
  const source = `import * as sdk from ${JSON.stringify(result.url)};
    import { assertFirebaseTestInitialization } from ${JSON.stringify(guardURL)};
    export * from ${JSON.stringify(result.url)};
    export function initializeApp(options, name) { return sdk.initializeApp(assertFirebaseTestInitialization(options), name); }
    export function cert() { throw new Error("Tests: cert() y credenciales reales están prohibidos"); }
    export function applicationDefault() { throw new Error("Tests: ADC está prohibido; usá el emulador"); }`;
  return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
} });
