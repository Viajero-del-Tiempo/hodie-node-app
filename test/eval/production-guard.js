import * as moduleAPI from "node:module";

let enabled = false;
const firebaseConfig = new URL("../../src/config/firebase.js", import.meta.url).href;
const forbidden = ["firebase-admin", "@google-cloud/firestore", "whatsapp-web.js", "cloudinary"];
const reject = () => { throw Object.assign(new Error("El runner solo admite dependencias en memoria; importación productiva bloqueada"), { code: "PRODUCTION_IMPORT_BLOCKED" }); };

export function memoryOnlyResolve(specifier, context, nextResolve) {
  if (forbidden.some(name => specifier === name || specifier.startsWith(name + "/"))) reject();
  const result = nextResolve(specifier, context);
  if (result.url === firebaseConfig || /\/node_modules\/(?:firebase-admin|@google-cloud\/firestore|whatsapp-web\.js|cloudinary)\//.test(result.url)) reject();
  return result;
}

export function enableMemoryOnly() {
  if (enabled) return;
  if (typeof moduleAPI.registerHooks !== "function") {
    throw new Error("El runner requiere Node con module.registerHooks; el runtime del proyecto es Node 24");
  }
  moduleAPI.registerHooks({ resolve: memoryOnlyResolve });
  enabled = true;
}
