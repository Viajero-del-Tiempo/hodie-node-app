import { textInput } from "../utils/customer-data.util.js";
import { validateOrderBilling } from "../validators/billing.validator.js";
import { analyzeRuc, validateRuc } from "../utils/ruc.util.js";
import { getShippingOptions, validateShippingAddress } from "./shipping.service.js";
import { cartIssue, purchaseError } from "./cart.service.js";

export function inspectPurchaseData(cart, { verifiedPhone, normalizePhone }) {
  const fields = [];
  const shipping = cart.shipping ?? {};
  for (const key of ["recipientName", "city", "department", "street"]) if (!shipping[key]) fields.push("shipping." + key);
  const options = shipping.city ? getShippingOptions(shipping.city) : null;
  if (options?.requiresRecipientDocument && !shipping.recipientDocument) fields.push("shipping.recipientDocument");
  const phone = verifiedPhone ?? normalizePhone(shipping.phone);
  if (!phone) fields.push("shipping.phone");
  const billing = cart.billing ?? {};
  let billingSnapshot = null;
  if (billing.invoiceRequested === null || billing.invoiceRequested === undefined) fields.push("billing.invoiceRequested");
  else if (billing.invoiceRequested === false) billingSnapshot = { invoiceRequested: false };
  else {
    if (!billing.legalName) fields.push("billing.legalName");
    if (!billing.ruc) fields.push("billing.ruc");
    if (billing.legalName && billing.ruc) {
      try { billingSnapshot = validateOrderBilling({ ...billing, acknowledgeRucMismatch: billing.rucValidation?.status === "mismatch_confirmed" }); }
      catch (error) { const issue = purchaseError(error); fields.push(issue.field); }
    }
  }
  for (const line of cart.lines) if (line.customization.textDraft !== null) fields.push("lines." + line.id + ".customization.text");
  const address = fields.some(field => field.startsWith("shipping.") && field !== "shipping.phone") ? null : validateShippingAddress(shipping);
  return { fields: [...new Set(fields)], options, shippingAddress: address, billing: billingSnapshot, phone };
}

// Recibe la autorización de RUC desde código del servidor, no desde el modelo.
export function createPurchaseDataService({ carts, normalizePhone, getProfile, rucAuthorization }) {
  return {
    async shipping(args, context = {}) {
      const cart = await carts.read(context) ?? carts.blank();
      for (const [key, value] of Object.entries(args)) {
        if (!["recipientName", "recipientDocument", "city", "department", "street", "phone"].includes(key)) throw cartIssue("ARGUMENTOS_INVALIDOS", key, "Campo de envío desconocido.");
        cart.shipping[key] = textInput(value, "shipping." + key) || null;
      }
      if (args.phone !== undefined) {
        const phone = normalizePhone(args.phone);
        if (!phone) throw cartIssue("TELEFONO_INVALIDO", "shipping.phone", "Ingresá un teléfono de contacto válido.");
        cart.shipping.phone = phone;
      }
      const saved = await carts.commit(cart, context);
      const options = saved.shipping.city ? getShippingOptions(saved.shipping.city) : null;
      return { code: "OK", cart: saved, shipping: saved.shipping, options };
    },
    async billing(args, context = {}) {
      const cart = await carts.read(context) ?? carts.blank();
      if (!args.invoiceRequested) {
        cart.billing = { invoiceRequested: false, legalName: null, ruc: null, rucValidation: null };
        const saved = await carts.commit(cart, context);
        return { code: "OK", cart: saved, billing: saved.billing };
      }
      let source = args;
      let ownedAcceptance = cart.billing.rucValidation?.status === "mismatch_confirmed"
        && (args.ruc === undefined || args.ruc === cart.billing.ruc)
        && (args.legalName === undefined || args.legalName === cart.billing.legalName);
      if (args.billingProfileId) {
        const profile = await getProfile(context);
        const row = profile?.billingProfiles?.find(row => row.id === args.billingProfileId);
        if (!row) throw cartIssue("PERFIL_FISCAL_NO_DISPONIBLE", "billingProfileId", "No encontramos ese registro en tu perfil verificado.");
        if (args.ruc !== undefined || args.legalName !== undefined || args.confirmedRuc !== undefined || args.acknowledgeRucMismatch !== undefined) {
          throw cartIssue("ARGUMENTOS_INVALIDOS", "billingProfileId", "Elegí el registro guardado o ingresá datos nuevos.");
        }
        source = row;
        ownedAcceptance = row.rucValidation?.status === "mismatch_confirmed";
      }
      const billing = { ...cart.billing, invoiceRequested: true };
      for (const key of ["legalName", "ruc"]) if (source[key] !== undefined) billing[key] = textInput(source[key], "billing." + key) || null;
      const fields = ["legalName", "ruc"].filter(key => !billing[key]).map(key => "billing." + key);
      let result = { code: fields.length ? "DATO_FALTANTE" : "OK", fields };
      let pending = null;
      if (billing.ruc) {
        const analysis = analyzeRuc(billing.ruc, "billing.ruc");
        billing.rucValidation = analysis;
        const authorization = await rucAuthorization({ args, billing, cartId: cart.id, previousRuc: cart.billing.ruc,
          profileSelected: Boolean(args.billingProfileId), ownedAcceptance, context });
        try {
          const validated = validateRuc(billing.ruc, { field: "billing.ruc",
            confirmedRuc: authorization.confirmedRuc, acknowledgeRucMismatch: authorization.acknowledgeRucMismatch });
          billing.ruc = validated.ruc; billing.rucValidation = validated.rucValidation;
        } catch (error) {
          result = purchaseError(error);
          pending = { kind: analysis.status === "confirmation_required" ? "ruc_completion" : "ruc_mismatch",
            input: billing.ruc, value: analysis.suggestedRuc, legalName: billing.legalName, cartId: cart.id };
        }
      }
      cart.billing = billing;
      const saved = await carts.commit(cart, context);
      return { ...result, cart: saved, billing: saved.billing, pending };
    },
  };
}
