import test from "node:test";
import assert from "node:assert/strict";
import { calculateRucDigit, analyzeRuc, validateRuc } from "../src/utils/ruc.util.js";
import { validateOrderBilling } from "../src/validators/billing.validator.js";

test("DV SET: RUC reales publicados de ANDE y COPACO", () => {
  // https://www.ande.gov.py/proveedores.php
  // https://www.contrataciones.gov.py/proveedor/compania-paraguaya-comunicaciones-s-a.html
  for (const ruc of ["80009735-1", "80023541-0"]) assert.equal(analyzeRuc(ruc).status, "valid");
});
test("personas físicas: distintas longitudes y pesos 2 a 11", () => {
  // Vectores ficticios; valores esperados calculados independientemente.
  for (const [base, digit] of [["123456", 0], ["1234567", 9], ["12345678", 9], ["123456789", 0], ["12345678901", 5]]) {
    assert.equal(calculateRucDigit(base), digit);
    assert.equal(analyzeRuc(`${base}-${digit}`).status, "valid");
  }
  assert.equal(calculateRucDigit("11"), 6);
  assert.equal(calculateRucDigit("0001234567"), 9);
  assert.equal(analyzeRuc("0001234567-9").ruc, "0001234567-9");
  assert.equal(calculateRucDigit("0"), 0); // resto 0
});
test("número base propone RUC, no lo guarda sin confirmación exacta", () => {
  const proposal = analyzeRuc("1234567");
  assert.equal(proposal.suggestedRuc, "1234567-9");
  assert.equal(proposal.requiresConfirmation, true);
  assert.throws(() => validateRuc("1234567"), error => error.code === "RUC_COMPLETION_REQUIRED" && error.suggestedRuc === "1234567-9");
  assert.throws(() => validateRuc("1234567", { confirmedRuc: "12345678-9" }));
  assert.throws(() => validateRuc("1234567", { acknowledgeRucMismatch: true }));
  assert.equal(validateRuc("1234567", { confirmedRuc: "1234567-9" }).ruc, "1234567-9");
});
test("DV distinto: corrección o aceptación explícita, nunca cambio automático", () => {
  assert.throws(() => validateRuc("1234567-8", { field: "billing.ruc" }), error => error.field === "billing.ruc" && error.code === "RUC_DV_MISMATCH");
  const accepted = validateRuc("1234567-8", { acknowledgeRucMismatch: true });
  assert.equal(accepted.ruc, "1234567-8");
  assert.deepEqual(accepted.rucValidation, { status: "mismatch_confirmed", expectedDigit: 9 });
  assert.equal(validateRuc("1234567-9").rucValidation.status, "valid");
});
test("formato, tipos y consumidor final", () => {
  for (const value of [null, 1234567, "", "ABC-1", "123-12", "123--1", "123.456-1", "123/1"]) assert.throws(() => analyzeRuc(value));
  assert.deepEqual(validateOrderBilling(undefined), { invoiceRequested: false });
  assert.deepEqual(validateOrderBilling({ invoiceRequested: false, ruc: "inválido", legalName: "descartar" }), { invoiceRequested: false });
  assert.throws(() => validateOrderBilling({ invoiceRequested: true, ruc: "1234567-9" }), error => error.field === "billing.legalName");
});
