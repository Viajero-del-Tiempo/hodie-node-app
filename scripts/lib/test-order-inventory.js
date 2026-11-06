export const inventoryCollections = Object.freeze([
  "orders", "users", "products", "categories", "policies", "handoff_threads", "lid_phone_map",
  "langgraph_checkpoint_writes", "agent_checkpoints", "agent_checkpoint_writes", "agent_chat_controls",
  "carts", "order_quotes", "order_confirmations", "order_pdf_jobs", "agent_alerts", "order_alerts",
  "payment_receipts", "agent_whatsapp_messages", "agent_whatsapp_deliveries", "agent_whatsapp_own_messages", "agent_whatsapp_maintenance",
]);
const phoneFields = {
  orders: ["userPhoneNumber"], users: ["phoneNumber"], handoff_threads: ["userPhoneNumber"], lid_phone_map: ["phoneNumber"],
  payment_receipts: ["ownerPhone"], agent_checkpoints: ["snapshot.userPhoneNumber"],
};
const chatFields = {
  orders: ["whatsappChatId"], handoff_threads: ["whatsappChatId", "thread_id"], agent_checkpoints: ["snapshot.whatsappChatId"],
  payment_receipts: ["ownerChatId", "acknowledgementChatId"], langgraph_checkpoint_writes: ["thread_id"], agent_checkpoint_writes: ["thread_id"],
};
const milliseconds = value => value?.toMillis?.() ?? value?.toDate?.().getTime() ?? (value instanceof Date ? value.getTime() : typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN);
const iso = value => Number.isFinite(milliseconds(value)) ? new Date(milliseconds(value)).toISOString() : null;

export function parseInventoryArgs(argv) {
  const options = { phones: [], markers: [], collections: [], limit: 1000, project: "hodie-tienda-de-regalos", from: null, to: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help") return { help: true };
    if (!["--phone", "--marker", "--from", "--to", "--limit", "--project", "--service-account", "--collection"].includes(flag)
        || argv[i + 1] === undefined || argv[i + 1].startsWith("--")) throw new Error("Argumento inválido: " + flag);
    const value = argv[++i];
    if (flag === "--phone") {
      const phone = value.replace(/[\s()+.-]/g, "");
      if (!/^[0-9]{9,15}$/u.test(phone)) throw new Error("--phone requiere un teléfono internacional, solo dígitos");
      options.phones.push(phone);
    } else if (flag === "--marker") {
      if (!value.trim()) throw new Error("--marker no puede estar vacío"); options.markers.push(value);
    } else if (flag === "--collection") {
      if (!inventoryCollections.includes(value) && value !== "checkpoints") throw new Error("Colección no admitida: " + value);
      options.collections.push(value);
    } else if (["--from", "--to"].includes(flag)) {
      if (!/(?:Z|[+-][0-9]{2}:[0-9]{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(flag + " requiere fecha ISO con zona horaria");
      options[flag.slice(2)] = Date.parse(value);
    } else if (flag === "--limit") {
      if (!/^[0-9]+$/u.test(value) || Number(value) < 1 || Number(value) > 10000) throw new Error("--limit debe estar entre 1 y 10000");
      options.limit = Number(value);
    } else options[flag === "--service-account" ? "serviceAccount" : "project"] = value;
  }
  if (options.from !== null && options.to !== null && options.from >= options.to) throw new Error("--from debe ser anterior a --to");
  if (!options.phones.length && !options.markers.length && options.from === null && options.to === null) options.phones.push("595981646055");
  if (!options.collections.length) options.collections = [...inventoryCollections, "checkpoints"];
  return options;
}

// El consumidor no recibe batch, transacciones, setters ni referencias mutables.
export function readOnlyFirestore(db) {
  const snapshot = doc => ({ id: doc.id, ref: Object.freeze({ path: doc.ref.path }), exists: doc.exists, data: () => doc.data() });
  const query = raw => Object.freeze({
    where: (...args) => query(raw.where(...args)), orderBy: (...args) => query(raw.orderBy(...args)),
    limit: count => query(raw.limit(count)), startAfter: cursor => query(raw.startAfter(cursor)),
    async get() { const result = await raw.get(); return { docs: result.docs.map(snapshot) }; },
  });
  return Object.freeze({ collection: name => query(db.collection(name)), collectionGroup: name => query(db.collectionGroup(name)),
    doc: path => Object.freeze({ async get() { return snapshot(await db.doc(path).get()); } }) });
}

export function documentMatches(doc, options, knownChats = new Set()) {
  const reasons = [], data = doc.data(), path = doc.ref.path;
  const phoneForms = options.phones.flatMap(phone => [phone, "+" + phone, "0" + phone.slice(3), phone.slice(3)]);
  function inspect(value, key, depth = 0) {
    if (depth > 12 || value === null || value === undefined) return;
    if ((Buffer.isBuffer(value) || value instanceof Uint8Array) && key.includes("checkpoint")) {
      try { inspect(JSON.parse(Buffer.from(value).toString("utf8")), key + ".json", depth + 1); } catch { /* Serialización no JSON: no inventar coincidencias. */ }
      return;
    }
    if (typeof value === "string") {
      if (options.markers.some(marker => value.startsWith(marker))) reasons.push("marca:" + key);
      if (phoneForms.includes(value) || knownChats.has(value)) reasons.push("teléfono/chat:" + key);
      // Checkpoints legacy serializan canales y mensajes como JSON, no campos consultables.
      if (key.includes("checkpoint") && value.startsWith("{")) {
        try { inspect(JSON.parse(value), key + ".json", depth + 1); } catch { /* No atribuir coincidencias por un parseo fallido. */ }
      }
    } else if (typeof value === "object" && typeof value.toMillis !== "function" && !(value instanceof Date)) {
      for (const [name, item] of Object.entries(value)) inspect(item, key ? key + "." + name : name, depth + 1);
    }
  }
  inspect(data, ""); inspect(doc.id, "id");
  if ([...knownChats].some(chat => path.split("/").includes(chat))) reasons.push("ruta:chat");
  const dateFields = ["createdAt", "updatedAt", "saved_at", "fecha", "receivedAt", "pausedAt", "associatedAt"];
  for (const field of dateFields) {
    const date = milliseconds(data[field]);
    if ((options.from !== null || options.to !== null) && Number.isFinite(date)
        && (options.from === null || date >= options.from) && (options.to === null || date < options.to)) reasons.push("fecha:" + field);
  }
  return [...new Set(reasons)];
}

export async function listTestDocuments(db, options, { documentId = "__name__", emit = () => {} } = {}) {
  const found = new Map(), chats = new Set(options.phones.flatMap(phone => [phone, phone + "@c.us"]));
  const references = new Set(), visited = new Set();
  const truncated = [], failedQueries = [];
  function add(doc, reasons) {
    if (!doc.exists || !reasons.length) return;
    const data = doc.data(), path = doc.ref.path;
    for (const [collection, id] of [["users", data.userId], ["orders", data.orderId], ["categories", data.categoryId],
      ...(Array.isArray(data.items) ? data.items : []).map(item => ["products", item.productId])]) {
      if (typeof id === "string" && id && !id.includes("/") && options.collections.includes(collection)) references.add(collection + "/" + id);
    }
    for (const value of [data.whatsappChatId, data.chatId, data.ownerChatId, data.thread_id]) if (typeof value === "string" && value.includes("@")) chats.add(value);
    const previous = found.get(path);
    found.set(path, { path, orderNumber: data.orderNumber ?? null, status: data.status ?? null,
      userId: data.userId ?? null, createdAt: iso(data.createdAt), updatedAt: iso(data.updatedAt ?? data.saved_at ?? data.fecha),
      matchReasons: [...new Set([...(previous?.matchReasons ?? []), ...reasons])] });
  }
  async function take(query, label, reason) {
    try {
      const result = await query.limit(options.limit + 1).get();
      if (result.docs.length > options.limit) truncated.push(label);
      for (const doc of result.docs.slice(0, options.limit)) add(doc, reason ? [reason] : documentMatches(doc, options, chats));
    } catch (error) {
      failedQueries.push({ query: label, code: error.code ?? null, message: String(error.message).slice(0, 300) });
    }
  }
  // Primero descubrir chats por pedidos/perfiles/índice, después seguir sus referencias.
  for (const collection of ["orders", "users", "handoff_threads", "lid_phone_map", ...options.collections.filter(name => !["orders", "users", "handoff_threads", "lid_phone_map"].includes(name))]) {
    if (!options.collections.includes(collection)) continue;
    const base = collection === "checkpoints" ? db.collectionGroup(collection) : db.collection(collection);
    for (const phone of options.phones) {
      for (const field of phoneFields[collection] ?? []) {
        for (const form of [phone, "+" + phone, "0" + phone.slice(3), phone.slice(3)]) await take(base.where(field, "==", form), `${collection}:${field}:${form}`, "teléfono:" + field);
      }
    }
    if (options.markers.length || options.from !== null || options.to !== null) await take(base.orderBy(documentId), collection + ":barrido", null);
  }
  const relations = ["orders", "handoff_threads", "lid_phone_map", "agent_chat_controls", "carts", "order_quotes", "order_confirmations", "order_pdf_jobs", "agent_alerts", "order_alerts", "payment_receipts", "agent_whatsapp_messages", "agent_whatsapp_deliveries", "agent_whatsapp_own_messages", "agent_whatsapp_maintenance", "langgraph_checkpoint_writes", "agent_checkpoint_writes", "agent_checkpoints", "checkpoints"];
  for (const collection of relations) {
    if (!options.collections.includes(collection)) continue;
    if (collection === "checkpoints") {
      // También funciona si el padre fue borrado; no exige un índice de grupo.
      for (const chat of chats) for (const parent of ["langgraph_checkpoints", "agent_checkpoints"]) {
        const path = `${parent}/${chat}/checkpoints`;
        await take(db.collection(path), path, "ruta de chat relacionado");
      }
      continue;
    }
    const base = collection === "checkpoints" ? db.collectionGroup(collection) : db.collection(collection);
    const fields = chatFields[collection] ?? [collection === "checkpoints" ? "thread_id" : "chatId"];
    for (const chat of chats) for (const field of fields) await take(base.where(field, "==", chat), `${collection}:${field}:${chat}`, "chat relacionado:" + field);
  }
  const referenceCounts = new Map();
  for (const path of references) {
    if (visited.has(path)) continue;
    const collection = path.split("/")[0], count = referenceCounts.get(collection) ?? 0;
    if (count >= options.limit) { if (!truncated.includes(collection + ":referencias")) truncated.push(collection + ":referencias"); continue; }
    referenceCounts.set(collection, count + 1);
    visited.add(path); const doc = await db.doc(path).get(); add(doc, ["referencia desde documento candidato"]);
  }
  // El contador no se puede atribuir a tests. Mostrar su valor actual sin tocarlo.
  const counter = await db.doc("counters/orderNumber").get();
  for (const row of [...found.values()].sort((a, b) => a.path.localeCompare(b.path))) emit(row);
  return { candidates: found.size, complete: truncated.length === 0 && failedQueries.length === 0, truncatedQueries: truncated, failedQueries,
    counter: counter.exists ? { path: counter.ref.path, lastOrderNumber: counter.data().lastOrderNumber ?? null, attribution: "No permite distinguir avances reales de avances de tests" } : null,
    note: "Son candidatos con evidencia, no autorización para borrar. Las fechas también pueden incluir documentos legítimos; sin escaneo no se detectan teléfonos presentes solo dentro de JSON serializado." };
}
