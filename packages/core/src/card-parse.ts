import { cardBrand, luhnValid } from "./detect";

export interface ParsedCard {
  number?: string;
  expMonth?: string;
  expYear?: string;
  cvv?: string;
  cardholder?: string;
  brand?: string | null;
}

const LABEL_WORDS = new Set([
  "card",
  "number",
  "no",
  "num",
  "credit",
  "debit",
  "exp",
  "expiry",
  "expires",
  "expiration",
  "valid",
  "thru",
  "through",
  "cvv",
  "cvc",
  "cvv2",
  "security",
  "code",
  "name",
  "holder",
  "cardholder",
  "on",
  "date",
  "mm",
  "yy",
  "yyyy",
  "visa",
  "mastercard",
  "amex",
  "american",
  "express",
  "discover",
  "jcb",
  "unionpay",
  "diners",
  "my",
  "new",
  "is",
  "the",
  "and",
]);

/**
 * Pulls card details out of whatever was pasted: "4111 1111 1111 1111 12/29 123
 * John Doe", "4111111111111111|12|2029|123", labelled lines, one value per
 * line… The number is found by Luhn, so expiry and CVV digits next to it are
 * never swallowed into it.
 */
export function parseCardText(text: string): ParsedCard {
  const out: ParsedCard = {};
  // Digit runs with their positions; separators between them are kept apart.
  const runs = [...text.matchAll(/\d+/g)].map((m) => ({
    v: m[0],
    start: m.index!,
    end: m.index! + m[0].length,
  }));
  const used = new Set<number>();

  // Card number: the longest Luhn-valid join of adjacent runs separated by a
  // single space or dash, 13–19 digits.
  let best: { from: number; to: number; digits: string } | undefined;
  for (let i = 0; i < runs.length; i++) {
    let digits = "";
    for (let j = i; j < runs.length; j++) {
      if (j > i && !/^[ -]$/.test(text.slice(runs[j - 1]!.end, runs[j]!.start))) break;
      digits += runs[j]!.v;
      if (digits.length > 19) break;
      if (digits.length >= 13 && luhnValid(digits) && (!best || digits.length > best.digits.length))
        best = { from: i, to: j, digits };
    }
  }
  if (best) {
    out.number = best.digits;
    out.brand = cardBrand(best.digits);
    for (let k = best.from; k <= best.to; k++) used.add(k);
  }

  // Expiry: MM/YY or MM/YYYY (or with - or space), else MMYY right after the number.
  const exp = text.match(/\b(0?[1-9]|1[0-2])\s*[/\-.]\s*(\d{4}|\d{2})\b/);
  if (exp) {
    out.expMonth = exp[1]!.padStart(2, "0");
    out.expYear = exp[2]!.length === 2 ? `20${exp[2]}` : exp[2]!;
    for (const [k, r] of runs.entries())
      if (r.start >= exp.index! && r.end <= exp.index! + exp[0].length) used.add(k);
  }

  // Labelled CVV first, then a 3–4 digit run left over.
  const labelled = text.match(/\b(?:cvv2?|cvc|security code|csc)\b\D{0,3}(\d{3,4})\b/i);
  if (labelled) {
    out.cvv = labelled[1];
    for (const [k, r] of runs.entries())
      if (r.v === labelled[1] && r.start > labelled.index!) used.add(k);
  }
  const rest = runs.map((r, k) => ({ ...r, k })).filter((r) => !used.has(r.k));
  // "4111…|12|2029|123": month and year as separate runs.
  if (!out.expMonth) {
    const m = rest.findIndex((r) => /^(0?[1-9]|1[0-2])$/.test(r.v));
    const y = m >= 0 ? rest[m + 1] : undefined;
    if (m >= 0 && y && /^(\d{2}|20\d{2})$/.test(y.v)) {
      out.expMonth = rest[m]!.v.padStart(2, "0");
      out.expYear = y.v.length === 2 ? `20${y.v}` : y.v;
      used.add(rest[m]!.k);
      used.add(y.k);
    } else {
      // "1229" straight after the number.
      const mmyy = rest.find((r) => /^(0[1-9]|1[0-2])\d{2}$/.test(r.v));
      if (mmyy) {
        out.expMonth = mmyy.v.slice(0, 2);
        out.expYear = `20${mmyy.v.slice(2)}`;
        used.add(mmyy.k);
      }
    }
  }
  if (!out.cvv) {
    const amex = out.brand === "Amex";
    const cvv = runs
      .map((r, k) => ({ ...r, k }))
      .find((r) => !used.has(r.k) && (amex ? /^\d{4}$/ : /^\d{3}$/).test(r.v));
    if (cvv) out.cvv = cvv.v;
  }

  // Cardholder: two or more words of letters that are not labels.
  for (const line of text.split(/[\r\n|,;]+/)) {
    const words = line
      .replace(/[^A-Za-z.' -]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    const name = words.filter((w) => !LABEL_WORDS.has(w.toLowerCase().replace(/[.:]$/, "")));
    if (
      name.length >= 2 &&
      name.length <= 5 &&
      name.every((w) => /^[A-Za-z][A-Za-z.'-]*$/.test(w))
    ) {
      out.cardholder = name.join(" ");
      break;
    }
  }
  return out;
}
