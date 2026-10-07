import { randomUUID, createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CustomerDataError, objectInput, textInput } from "../utils/customer-data.util.js";
import { profileVersion, assertProfileVersion } from "../utils/profile-version.util.js";
import { validateShippingAddress } from "./shipping.service.js";
import { validateBillingDetails } from "../validators/billing.validator.js";

// IDs de lectura deterministas para direcciones antiguas. Se materializan al
// primer guardado del dueño, sin backfill. La versión impide editar otra fila.
export function normalizeProfileLists(data) {
  const addresses = (Array.isArray(data.addresses) ? data.addresses : []).map((address, index) => ({
    ...address, id: address.id || "legacy-" + createHash("sha256").update(JSON.stringify([index, address])).digest("hex").slice(0, 24),
  }));
  const billingProfiles = Array.isArray(data.billingProfiles) ? data.billingProfiles : [];
  return { addresses, billingProfiles,
    defaultAddressId: addresses.some(row => row.id === data.defaultAddressId) ? data.defaultAddressId : addresses[0]?.id ?? null,
    defaultBillingProfileId: billingProfiles.some(row => row.id === data.defaultBillingProfileId) ? data.defaultBillingProfileId : billingProfiles[0]?.id ?? null,
  };
}

function validateRows(input, previous, field, validate, generateId) {
  if (!Array.isArray(input) || input.length > 30) throw new CustomerDataError(field, "Ingresá una lista de hasta 30 registros.");
  const seen = new Set();
  return input.map((row, index) => {
    objectInput(row, `${field}[${index}]`);
    const old = previous.find(item => item.id === row.id);
    if (row.id !== undefined && (!old || seen.has(row.id))) {
      throw new CustomerDataError(`${field}[${index}].id`, "El ID no pertenece al perfil o está repetido.");
    }
    const id = row.id ?? generateId();
    seen.add(id);
    // Direcciones anteriores incompletas solo se conservan si no fueron editadas.
    const unchanged = old && isDeepStrictEqual({ ...row, id: undefined }, { ...old, id: undefined });
    return { id, ...validate(row, `${field}[${index}]`, unchanged) };
  });
}

function defaultId(input, rows, current, field) {
  if (!rows.length) {
    if (input !== undefined && input !== null) throw new CustomerDataError(field, "No hay registros para elegir como predeterminado.");
    return null;
  }
  const selected = input === undefined ? (rows.some(row => row.id === current) ? current : rows[0].id) : input;
  if (!rows.some(row => row.id === selected)) throw new CustomerDataError(field, "Elegí un registro guardado en tu perfil.");
  return selected;
}

export function validateProfileUpdate(input, current, { generateId = randomUUID } = {}) {
  objectInput(input, "profile");
  const previous = normalizeProfileLists(current);
  const update = {};
  if (input.displayName !== undefined) update.displayName = textInput(input.displayName, "displayName", { required: true });
  if (input.addresses !== undefined) {
    update.addresses = validateRows(input.addresses, previous.addresses, "addresses",
      (row, field, unchanged) => validateShippingAddress(row, { field, legacy: Boolean(unchanged) }), generateId);
  } else update.addresses = previous.addresses;
  if (input.billingProfiles !== undefined) {
    update.billingProfiles = validateRows(input.billingProfiles, previous.billingProfiles, "billingProfiles", (row, field, unchanged) => {
      const details = validateBillingDetails({ ...row,
        // Una discrepancia ya aceptada se conserva únicamente si el registro no cambió.
        acknowledgeRucMismatch: row.acknowledgeRucMismatch ?? Boolean(unchanged && oldValidation(previous.billingProfiles, row.id)),
      }, field);
      return { alias: textInput(row.alias, `${field}.alias`), ...details };
    }, generateId);
  } else update.billingProfiles = previous.billingProfiles;
  update.defaultAddressId = defaultId(input.defaultAddressId, update.addresses, previous.defaultAddressId, "defaultAddressId");
  update.defaultBillingProfileId = defaultId(input.defaultBillingProfileId, update.billingProfiles, previous.defaultBillingProfileId, "defaultBillingProfileId");
  return update;
}

function oldValidation(rows, id) { return rows.find(row => row.id === id)?.rucValidation?.status === "mismatch_confirmed"; }

export function createProfileService({ db, timestampNow, generateId = randomUUID }) {
  const dto = snapshot => {
    const data = snapshot.data();
    return { uid: snapshot.id, phoneNumber: data.phoneNumber, displayName: data.displayName ?? "",
      role: data.role ?? "customer", whatsapp_verified: data.whatsapp_verified === true,
      profile_status: data.profile_status ?? "incomplete", active: data.active !== false,
      createdAt: data.createdAt ?? null, billingAddress: data.billingAddress ?? null,
      ...normalizeProfileLists(data), version: profileVersion(snapshot) };
  };
  async function getRef(phone) {
    const result = await db.collection("users").where("phoneNumber", "==", phone).limit(1).get();
    if (result.empty) throw new CustomerDataError("profile", "Perfil de usuario no encontrado.", 404);
    return result.docs[0].ref;
  }
  async function get(phone) {
    const snapshot = await (await getRef(phone)).get();
    if (!snapshot.exists) throw new CustomerDataError("profile", "Perfil de usuario no encontrado.", 404);
    return dto(snapshot);
  }
  async function update(phone, input) {
    const ref = await getRef(phone);
    // Se preasignan IDs para reutilizarlos en reintentos de la transacción.
    const ids = new Map();
    let nextId = 0;
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists || snapshot.data().phoneNumber !== phone) throw new CustomerDataError("profile", "Perfil no encontrado.", 404);
      if (snapshot.data().active === false) throw new CustomerDataError("profile", "Usuario inactivo.", 403);
      assertProfileVersion(snapshot, input?.version);
      nextId = 0;
      const update = validateProfileUpdate(input, snapshot.data(), { generateId: () => {
        const key = nextId++;
        if (!ids.has(key)) ids.set(key, generateId());
        return ids.get(key);
      } });
      transaction.update(ref, { ...update, updatedAt: timestampNow() });
    });
    return dto(await ref.get());
  }
  // Guardado opcional posterior al pedido. Relee dentro de la transacción:
  // agrega sin sustituir listas, nunca cambia predeterminados existentes.
  async function saveCheckoutDetails(uid, { shippingAddress, billing, saveShippingAddress, saveBillingProfile }) {
    if (!saveShippingAddress && !saveBillingProfile) return;
    const ref = db.collection("users").doc(uid);
    const addressId = generateId();
    const billingId = generateId();
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists || snapshot.data().active === false) throw new CustomerDataError("profile", "No se pudo guardar en el perfil.", 403);
      const lists = normalizeProfileLists(snapshot.data());
      const update = {};
      if (saveShippingAddress) {
        const same = lists.addresses.find(row => Object.keys(shippingAddress).every(key => (row[key] ?? "") === shippingAddress[key]));
        if (!same) {
          if (lists.addresses.length >= 30) throw new CustomerDataError("addresses", "El perfil admite hasta 30 direcciones.");
          lists.addresses.push({ id: addressId, ...shippingAddress });
        }
        update.addresses = lists.addresses;
        update.defaultAddressId = lists.defaultAddressId ?? lists.addresses[0].id;
      }
      if (saveBillingProfile && billing.invoiceRequested) {
        const same = lists.billingProfiles.find(row => row.ruc === billing.ruc && row.legalName === billing.legalName);
        if (!same) {
          if (lists.billingProfiles.length >= 30) throw new CustomerDataError("billingProfiles", "El perfil admite hasta 30 registros de facturación.");
          const { invoiceRequested: _requested, ...details } = billing;
          lists.billingProfiles.push({ id: billingId, alias: "", ...details });
        }
        update.billingProfiles = lists.billingProfiles;
        update.defaultBillingProfileId = lists.defaultBillingProfileId ?? lists.billingProfiles[0].id;
      }
      transaction.update(ref, { ...update, updatedAt: timestampNow() });
    });
  }
  return { get, update, saveCheckoutDetails };
}
