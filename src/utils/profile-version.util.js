import { createHash } from "node:crypto";
import { CustomerDataError } from "./customer-data.util.js";

const fields = ["displayName", "addresses", "defaultAddressId", "billingProfiles", "defaultBillingProfileId", "billingAddress"];
const digest = value => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
const time = snapshot => `${snapshot.updateTime.seconds}:${snapshot.updateTime.nanoseconds}`;
export function profileVersion(snapshot) {
  const data = snapshot.data();
  return Buffer.from(JSON.stringify({ id: snapshot.id, time: time(snapshot),
    hashes: Object.fromEntries(fields.map(field => [field, digest(data[field])])),
  })).toString("base64url");
}

export function assertProfileVersion(snapshot, value) {
  let previous;
  try {
    if (typeof value !== "string" || value.length > 5000 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    previous = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (previous.id !== snapshot.id || typeof previous.time !== "string"
        || fields.some(field => typeof previous.hashes?.[field] !== "string")) throw new Error();
  } catch { throw new CustomerDataError("version", "Se requiere la versión del perfil que abriste."); }
  if (previous.time === time(snapshot)) return;
  const data = snapshot.data();
  const changes = fields.filter(field => previous.hashes[field] !== digest(data[field])).map(field => ({ field }));
  const labels = { displayName: "nombre", addresses: "direcciones", defaultAddressId: "dirección predeterminada",
    billingProfiles: "datos de facturación", defaultBillingProfileId: "facturación predeterminada", billingAddress: "dirección postal de facturación" };
  throw new CustomerDataError("version", "El perfil cambió: "
    + (changes.length ? changes.map(change => labels[change.field]).join(", ") : "se actualizó el documento")
    + ". Tu borrador no se guardó; recargá el perfil para revisar los cambios.", 409,
  { code: "PROFILE_VERSION_CONFLICT", changes });
}
