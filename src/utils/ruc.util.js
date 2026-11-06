import { CustomerDataError, textInput } from "./customer-data.util.js";

// SET/DNIT: Pa_Calcular_Dv_11_A, basemax 11. Entrada numérica, sin longitud fija.
// https://www.dnit.gov.py/documents/20123/224893/D%C3%ADgito%2BVerificador.pdf/fb9f86c8-245d-9dad-2dc1-ac3b3dc307a7
export function calculateRucDigit(base) {
  if (typeof base !== "string" || !/^\d+$/.test(base) || base.length > 200) {
    throw new CustomerDataError("ruc", "Ingresá el número base del RUC usando solo dígitos.");
  }
  let total = 0;
  let weight = 2;
  for (let index = base.length - 1; index >= 0; index--) {
    total += Number(base[index]) * weight;
    weight = weight === 11 ? 2 : weight + 1;
  }
  const remainder = total % 11;
  return remainder > 1 ? 11 - remainder : 0;
}

export function analyzeRuc(value, field = "ruc") {
  const ruc = textInput(value, field, { required: true });
  const match = /^(\d+)(?:-(\d))?$/.exec(ruc);
  if (!match) throw new CustomerDataError(field, "Ingresá el número del RUC, un guion y un dígito verificador.");
  const expectedDigit = calculateRucDigit(match[1]);
  const suggestedRuc = `${match[1]}-${expectedDigit}`;
  if (match[2] === undefined) {
    return { ruc, suggestedRuc, expectedDigit, status: "confirmation_required", requiresConfirmation: true };
  }
  const matches = Number(match[2]) === expectedDigit;
  return { ruc, expectedDigit, suggestedRuc, status: matches ? "valid" : "mismatch", requiresConfirmation: !matches };
}

export function validateRuc(value, { field = "ruc", confirmedRuc, acknowledgeRucMismatch = false } = {}) {
  let analysis = analyzeRuc(value, field);
  if (analysis.status === "confirmation_required") {
    if (confirmedRuc !== analysis.suggestedRuc) {
      throw new CustomerDataError(field, `¿Tu RUC es ${analysis.suggestedRuc}? Confirmalo antes de guardarlo.`, 400, {
        code: "RUC_COMPLETION_REQUIRED", suggestedRuc: analysis.suggestedRuc, requiresConfirmation: true,
      });
    }
    analysis = analyzeRuc(confirmedRuc, field);
  }
  if (analysis.status === "mismatch" && acknowledgeRucMismatch !== true) {
    throw new CustomerDataError(field, "El dígito verificador no coincide. Corregí el RUC o confirmá que querés usarlo como lo ingresaste.", 400, {
      code: "RUC_DV_MISMATCH", expectedDigit: analysis.expectedDigit, requiresConfirmation: true,
    });
  }
  return { ruc: analysis.ruc, rucValidation: {
    status: analysis.status === "mismatch" ? "mismatch_confirmed" : "valid", expectedDigit: analysis.expectedDigit,
  } };
}
