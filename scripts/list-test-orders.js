import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseInventoryArgs, readOnlyFirestore, listTestDocuments } from "./lib/test-order-inventory.js";
import { isFirebaseTestProcess } from "../src/config/firebase-test-environment.js";

export async function main(argv = process.argv.slice(2)) {
  const options = parseInventoryArgs(argv);
  if (options.help) {
    console.log("Solo lectura: node scripts/list-test-orders.js [--phone N] [--marker test-] [--from ISO] [--to ISO] [--collection NOMBRE] [--limit 1000] [--service-account ARCHIVO] [--project ID]. Sin filtros: teléfono 595981646055. Filtros combinados por OR. Marcas/fechas habilitan barridos limitados por colección; fechas [from,to), con zona horaria.");
    return;
  }
  if (isFirebaseTestProcess() || process.env.FIRESTORE_EMULATOR_HOST) throw new Error("El inventario productivo no se ejecuta desde tests ni con FIRESTORE_EMULATOR_HOST. No se abrió Firebase.");
  const path = resolve(options.serviceAccount ?? process.env.FIREBASE_SERVICE_ACCOUNT_PATH ?? "serviceAccountKey.json");
  const account = JSON.parse(await readFile(path, "utf8"));
  if (account.project_id !== options.project) throw new Error("El proyecto de la credencial no coincide con --project; no se abrió Firebase");
  const [{ initializeApp, cert, deleteApp }, { getFirestore, FieldPath }] = await Promise.all([import("firebase-admin/app"), import("firebase-admin/firestore")]);
  const app = initializeApp({ credential: cert(account), projectId: options.project }, "read-only-test-inventory");
  const db = getFirestore(app);
  console.error("Inventario SOLO LECTURA. Proyecto: " + options.project);
  try {
    const summary = await listTestDocuments(readOnlyFirestore(db), options, { documentId: FieldPath.documentId(), emit: row => console.log(JSON.stringify(row)) });
    console.log(JSON.stringify({ summary }));
    if (!summary.complete) process.exitCode = 2;
  } finally { try { await db.terminate(); } finally { await deleteApp(app); } }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
