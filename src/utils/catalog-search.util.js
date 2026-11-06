// Vocabulario gramatical y verbos de consulta; nunca términos del catálogo.
const STOP_WORDS = new Set(`
  a al algo ante bajo con contra cual cuales como de del desde donde durante
  e el ella ellas ellos en entre era es esa esas ese esos esta estas este estos
  esto fue ha hacia hasta hay la las le les lo los mas me mi mis muy o para
  pero por que quien quienes se segun si sin sobre su sus te tu tus un una
  unas unos y ya yo quiero quisiera busco buscar necesito necesitamos ver
  mostrar mostrame muestrame
`.trim().split(/\s+/u));

export function normalizeSearchText(value) {
  return String(value).toLowerCase().normalize("NFD")
    .replace(/n\u0303/gu, "ñ")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim().replace(/\s+/gu, " ");
}

export function tokenizeSearchText(value) {
  const normalized = normalizeSearchText(value);
  return normalized ? normalized.split(" ") : [];
}

export function getQueryTerms(query) {
  return [...new Set(tokenizeSearchText(query).filter(term => !STOP_WORDS.has(term)))];
}

// Heurística de plurales regulares. Conserva la forma original para priorizarla.
// Las terminaciones ambiguas pueden producir falsos positivos; no usa excepciones.
export function pluralForms(word) {
  const forms = new Set([word]);
  if (word.length > 4 && word.endsWith("ces")) forms.add(`${word.slice(0, -3)}z`);
  if (word.length > 4 && /[^aeiou]es$/u.test(word)) forms.add(word.slice(0, -2));
  if (word.length > 3 && /[aeiou]s$/u.test(word)) forms.add(word.slice(0, -1));
  return forms;
}

export function matchSearchTerm(term, words) {
  if (words.includes(term)) return 2;
  const forms = pluralForms(term);
  return words.some(word => [...pluralForms(word)].some(form => forms.has(form))) ? 1 : 0;
}

export function compareScores(left, right) {
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return right[index] - left[index];
  }
  return 0;
}

// Cada evaluación usa una sola variante: no combina opciones incompatibles.
export function scoreProductVariant(product, category, variant, terms) {
  const fields = [
    tokenizeSearchText(product.name),
    (product.tags ?? []).flatMap(tokenizeSearchText),
    tokenizeSearchText(category.name),
    Object.values(variant.options ?? {}).flatMap(tokenizeSearchText),
    Object.values(product.attributes ?? {}).flatMap(tokenizeSearchText),
  ];
  const counts = fields.map(() => 0);
  const exactCounts = fields.map(() => 0);
  const matchedTerms = [];
  for (const term of terms) {
    for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex++) {
      const match = matchSearchTerm(term, fields[fieldIndex]);
      if (!match) continue;
      matchedTerms.push(term);
      counts[fieldIndex]++;
      if (match === 2) exactCounts[fieldIndex]++;
      break;
    }
  }
  const fullName = terms.length > 0 && normalizeSearchText(product.name) === terms.join(" ");
  return {
    matchedTerms,
    score: [matchedTerms.length, ...counts.flatMap((count, index) => [count, exactCounts[index]]), Number(fullName)],
  };
}

export function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
