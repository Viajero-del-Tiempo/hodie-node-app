import "./firebase-bootstrap.js";
import { readFile } from "node:fs/promises";
import { openCatalogTestFirestore } from "./helpers/catalog-firestore.js";

// Solo datos ficticios, en el proyecto demo único de esta suite.
const fixtures = JSON.parse(await readFile(new URL("./fixtures/legacy-products.json", import.meta.url), "utf8"));
const context = await openCatalogTestFirestore();
try {
  for (const product of fixtures) {
    const { id, ...data } = product;
    await context.db.collection("products").doc(id).create(data);
  }
} finally { await context.close(); }
