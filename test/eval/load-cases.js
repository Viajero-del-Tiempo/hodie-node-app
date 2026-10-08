import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { validateContext } from "./initial-state.js";
import { resolveToolNames } from "./tool-names.js";

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const pathText = path => path.reduce((text, part) => text + (typeof part === "number" ? "[" + part + "]" : (text ? "." : "") + part), "");

export function parseCases(source, filename = "conversations.yaml") {
  const lineCounter = new YAML.LineCounter();
  const document = YAML.parseDocument(source, { version: "1.2", strict: true, uniqueKeys: true, lineCounter });
  function position(path) {
    for (let size = path.length; size >= 0; size--) {
      const node = size ? document.getIn(path.slice(0, size), true) : document.contents;
      if (node?.range) return lineCounter.linePos(node.range[0]);
    }
    return { line: 1, col: 1 };
  }
  const diagnostic = (path, message, code, caseId = null) => ({
    code, message, caseId, file: filename, path: pathText(path), ...position(path),
  });
  const errors = document.errors.map(error => ({
    code: "YAML_ERROR", file: filename, ...lineCounter.linePos(error.pos[0]), message: error.message,
  }));
  const warnings = document.warnings.map(error => ({
    code: "YAML_WARNING", file: filename, ...lineCounter.linePos(error.pos[0]), message: error.message,
  }));
  let data = null;
  if (!errors.length) {
    try { data = document.toJS({ maxAliasCount: 100 }); }
    catch (error) { errors.push(diagnostic([], error.message, "YAML_ERROR")); }
  }
  const categories = new Map();
  const cases = [];
  function fail(path, message) { errors.push(diagnostic(path, message, "INVALID_FILE")); }
  if (!errors.length) {
    if (!isObject(data)) fail([], "La raíz debe ser un objeto");
    else {
      if (data.version !== 2) fail(["version"], "El runner requiere el formato version: 2");
      if (!isObject(data.fixtures)) fail(["fixtures"], "Faltan fixtures");
      else {
        for (const key of ["categories", "products", "orders"]) {
          if (!Array.isArray(data.fixtures[key])) fail(["fixtures", key], "Debe ser una lista");
        }
        if (!isObject(data.fixtures.policies) || Object.values(data.fixtures.policies).some(value => typeof value !== "string")) {
          fail(["fixtures", "policies"], "Debe ser un objeto de temas y textos");
        }
        for (const [key, identifier] of [["categories", "id"], ["products", "id"], ["orders", "orderNumber"]]) {
          const seen = new Set();
          (Array.isArray(data.fixtures[key]) ? data.fixtures[key] : []).forEach((item, index) => {
            if (!isObject(item) || typeof item[identifier] !== "string" || !item[identifier]) {
              fail(["fixtures", key, index], "Falta " + identifier); return;
            }
            if (seen.has(item[identifier])) fail(["fixtures", key, index, identifier], "Identificador duplicado");
            seen.add(item[identifier]);
            if (key === "categories" && typeof item.name !== "string") fail(["fixtures", key, index, "name"], "Falta el nombre");
            if (key === "orders" && (typeof item.userPhoneNumber !== "string" || typeof item.status !== "string" || !Array.isArray(item.items))) {
              fail(["fixtures", key, index], "Pedido sin teléfono, estado o líneas");
            }
            if (key === "products") {
              if (typeof item.name !== "string" || !Array.isArray(data.fixtures.categories) || !data.fixtures.categories.some(category => category?.id === item.categoryId)) {
                fail(["fixtures", key, index], "Producto sin nombre o con categoría inexistente");
              }
              if (!Array.isArray(item.variants) || !item.variants.length) fail(["fixtures", key, index, "variants"], "Faltan variantes");
              if (item.packagingOptions !== undefined) {
                if (!Array.isArray(item.packagingOptions)) fail(["fixtures", key, index, "packagingOptions"], "Debe ser una lista");
                else item.packagingOptions.forEach((pack, packIndex) => {
                  if (!isObject(pack) || typeof pack.type !== "string" || !pack.type || typeof pack.name !== "string"
                      || !Number.isSafeInteger(pack.price) || pack.price < 0) {
                    fail(["fixtures", key, index, "packagingOptions", packIndex], "Empaque sin tipo, nombre o precio válido");
                  }
                });
              }
              const ids = new Set();
              (Array.isArray(item.variants) ? item.variants : []).forEach((variant, variantIndex) => {
                const path = ["fixtures", key, index, "variants", variantIndex];
                if (!isObject(variant) || typeof variant.id !== "string" || !variant.id || ids.has(variant.id)) {
                  fail(path, "Variante sin ID o con ID duplicado"); return;
                }
                ids.add(variant.id);
                if (typeof variant.sku !== "string" || !variant.sku || !isObject(variant.options)) {
                  fail(path, "Variante sin SKU u opciones");
                }
                if (!Number.isSafeInteger(variant.price) || variant.price < 0 || !Number.isSafeInteger(variant.stock) || variant.stock < 0) {
                  fail(path, "Precio y stock deben ser enteros no negativos");
                }
              });
            }
          });
        }
      }
      if (!Array.isArray(data.cases)) fail(["cases"], "Falta la lista de casos");
      else {
        const identifiers = new Map();
        data.cases.forEach((item, index) => {
          const diagnostics = [];
          const root = ["cases", index];
          const issue = (path, message, code = "INVALID_CASE") => diagnostics.push(diagnostic(path, message, code, item?.id ?? null));
          if (!isObject(item)) issue(root, "El caso debe ser un objeto");
          else {
            for (const key of Object.keys(item)) {
              if (!["id", "category", "source", "notes", "context", "turns", "expect"].includes(key)) issue([...root, key], "Clave de caso desconocida");
            }
            for (const key of ["id", "category"]) {
              if (typeof item[key] !== "string" || !item[key].trim()) issue([...root, key], "Debe ser texto no vacío");
            }
            if (typeof item.category === "string") categories.set(item.category, (categories.get(item.category) ?? 0) + 1);
            if (identifiers.has(item.id)) {
              issue([...root, "id"], "ID de caso duplicado", "DUPLICATE_CASE_ID");
              const previous = cases[identifiers.get(item.id)];
              previous.diagnostics.push(diagnostic(["cases", identifiers.get(item.id), "id"], "ID de caso duplicado", "DUPLICATE_CASE_ID", item.id));
            } else identifiers.set(item.id, index);
            if (Object.hasOwn(item, "context") && !errors.length) validateContext(item.context, data.fixtures, issue, [...root, "context"]);
            if (!Array.isArray(item.turns) || !item.turns.length) issue([...root, "turns"], "Se requiere al menos un turno");
            else item.turns.forEach((turn, turnIndex) => {
              const path = [...root, "turns", turnIndex];
              if (!isObject(turn)) { issue(path, "El turno debe ser un objeto"); return; }
              for (const key of Object.keys(turn)) {
                if (!["user", "burst", "attachment", "filename"].includes(key)) issue([...path, key], "Clave de turno desconocida");
              }
              if (typeof turn.user !== "string" || !turn.user.trim()) issue([...path, "user"], "Se requiere un mensaje");
              if (Object.hasOwn(turn, "burst") && (!Array.isArray(turn.burst) || turn.burst.some(text => typeof text !== "string" || !text.trim()))) {
                issue([...path, "burst"], "La ráfaga debe contener textos no vacíos");
              }
              if (Object.hasOwn(turn, "attachment") && !["image", "audio", "document", "file"].includes(turn.attachment)) issue([...path, "attachment"], "Adjunto no soportado");
              if (Object.hasOwn(turn, "filename") && typeof turn.filename !== "string") issue([...path, "filename"], "Debe ser texto");
            });
            if (!isObject(item.expect)) issue([...root, "expect"], "Faltan expectativas");
            else {
              for (const key of Object.keys(item.expect)) {
                if (!["must", "must_not", "tools_called", "tools_not_called", "handoff"].includes(key)) issue([...root, "expect", key], "Expectativa desconocida");
              }
              for (const key of ["must", "must_not", "tools_called", "tools_not_called"]) {
                const list = item.expect[key];
                if (list === undefined) continue;
                if (!Array.isArray(list) || list.some(value => typeof value !== "string" || !value.trim())) issue([...root, "expect", key], "Debe ser una lista de textos");
                else if (key.startsWith("tools_")) list.forEach((name, toolIndex) => {
                  if (!resolveToolNames(name)) issue([...root, "expect", key, toolIndex], "Herramienta desconocida: " + name, "UNKNOWN_TOOL");
                });
              }
              if (!["si", "no", "ofrece"].includes(item.expect.handoff)) issue([...root, "expect", "handoff"], "Debe ser si, no u ofrece");
            }
          }
          cases.push({
            id: item?.id ?? "invalid-" + index, category: item?.category ?? null, input: item,
            diagnostics, location: position(root),
            criterionLocation: (kind, criterionIndex) => ({ file: filename, ...position([...root, "expect", kind, criterionIndex]) }),
            contextLocation: () => ({ file: filename, ...position([...root, "context", "cotizacionMostrada"]) }),
          });
        });
      }
    }
  }
  return {
    filename, hash: createHash("sha256").update(source).digest("hex"), version: data?.version ?? null,
    fixtures: data?.fixtures ?? null, cases, categories: Object.fromEntries([...categories].sort()),
    errors, warnings,
  };
}
export async function loadCases(filename) {
  return parseCases(await readFile(filename, "utf8"), filename);
}
export function validationSummary(dataset) {
  return {
    version: dataset.version, errors: dataset.errors, warnings: dataset.warnings,
    cases: dataset.cases.length, categories: dataset.categories,
    caseDiagnostics: dataset.cases.flatMap(item => item.diagnostics),
  };
}
