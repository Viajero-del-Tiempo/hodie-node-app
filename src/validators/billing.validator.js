import { booleanInput, objectInput, textInput } from "../utils/customer-data.util.js";
import { validateRuc } from "../utils/ruc.util.js";

export function validateBillingDetails(value, field = "billing") {
  const input = objectInput(value, field);
  const legalName = textInput(input.legalName, `${field}.legalName`, { required: true });
  const ruc = validateRuc(input.ruc, { field: `${field}.ruc`, confirmedRuc: input.confirmedRuc,
    acknowledgeRucMismatch: booleanInput(input.acknowledgeRucMismatch, `${field}.acknowledgeRucMismatch`),
  });
  return { legalName, ...ruc };
}

export function validateOrderBilling(value) {
  if (value === undefined) return { invoiceRequested: false };
  const input = objectInput(value, "billing");
  if (!booleanInput(input.invoiceRequested, "billing.invoiceRequested")) return { invoiceRequested: false };
  return { invoiceRequested: true, ...validateBillingDetails(input) };
}
