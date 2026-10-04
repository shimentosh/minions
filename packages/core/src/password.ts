export interface PasswordOptions {
  length: number;
  uppercase: boolean;
  lowercase: boolean;
  numbers: boolean;
  symbols: boolean;
  /** Drops look-alike characters (0/O, 1/l/I). */
  avoidAmbiguous?: boolean;
}

export const DEFAULT_PASSWORD_OPTIONS: PasswordOptions = {
  length: 20,
  uppercase: true,
  lowercase: true,
  numbers: true,
  symbols: true,
  avoidAmbiguous: false,
};

const SETS = {
  uppercase: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  lowercase: "abcdefghijklmnopqrstuvwxyz",
  numbers: "0123456789",
  symbols: "!@#$%^&*()-_=+[]{};:,.?/~",
};
const AMBIGUOUS = /[0O1lI|]/g;

/** Unbiased integer in [0, max) from the platform CSPRNG. */
function randomInt(max: number): number {
  if (max <= 0 || max > 2 ** 32) throw new Error("Invalid range");
  const limit = 2 ** 32 - (2 ** 32 % max);
  const buf = new Uint32Array(1);
  while (true) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % max;
  }
}

export function generatePassword(options: PasswordOptions = DEFAULT_PASSWORD_OPTIONS): string {
  const length = Math.min(Math.max(Math.floor(options.length), 4), 256);
  const sets = (Object.keys(SETS) as (keyof typeof SETS)[])
    .filter((name) => options[name])
    .map((name) => (options.avoidAmbiguous ? SETS[name].replace(AMBIGUOUS, "") : SETS[name]));
  if (sets.length === 0) throw new Error("Select at least one character set");

  // One from every chosen set, the rest from the union, then shuffle.
  const chars = sets.map((set) => set[randomInt(set.length)]!);
  const all = sets.join("");
  while (chars.length < length) chars.push(all[randomInt(all.length)]!);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

export type StrengthScore = 0 | 1 | 2 | 3 | 4;

export interface StrengthResult {
  score: StrengthScore;
  label: "Very weak" | "Weak" | "Fair" | "Strong" | "Very strong";
  entropyBits: number;
  warnings: string[];
}

const COMMON = new Set([
  "password",
  "123456",
  "12345678",
  "123456789",
  "qwerty",
  "abc123",
  "111111",
  "letmein",
  "welcome",
  "admin",
  "iloveyou",
  "monkey",
  "dragon",
  "football",
  "baseball",
  "master",
  "sunshine",
  "princess",
  "passw0rd",
  "p@ssw0rd",
  "p@ssword",
  "trustno1",
  "shadow",
  "superman",
  "login",
  "starwars",
  "hello",
  "freedom",
  "whatever",
  "qazwsx",
  "1234567890",
  "000000",
  "password1",
  "password123",
  "qwerty123",
  "1q2w3e4r",
  "zaq12wsx",
  "changeme",
  "secret",
]);
const SEQUENCES = ["abcdefghijklmnopqrstuvwxyz", "0123456789", "qwertyuiopasdfghjklzxcvbnm"];

/**
 * A conservative estimator: charset entropy, discounted for repeats,
 * sequences, dictionary hits and short length. Deliberately simpler than
 * zxcvbn; it only has to separate "weak" from "fine" for the Security Center.
 */
export function estimateStrength(password: string): StrengthResult {
  const warnings: string[] = [];
  if (!password) return { score: 0, label: "Very weak", entropyBits: 0, warnings: ["Empty"] };

  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[^A-Za-z0-9]/.test(password)) pool += 33;

  const unique = new Set(password).size;
  let effectiveLength = Math.min(password.length, unique * 2.5);

  const lower = password.toLowerCase();
  const stripped = lower.replace(/[^a-z0-9@$!]/g, "").replace(/\d+$/, "");
  if (COMMON.has(lower) || COMMON.has(stripped)) {
    warnings.push("Common password");
    effectiveLength = Math.min(effectiveLength, 2);
  }
  if (/(.)\1{2,}/.test(password)) {
    warnings.push("Repeated characters");
    effectiveLength -= 2;
  }
  for (const seq of SEQUENCES) {
    for (let i = 0; i + 4 <= seq.length; i++) {
      const run = seq.slice(i, i + 4);
      if (lower.includes(run) || lower.includes([...run].reverse().join(""))) {
        warnings.push("Contains a sequence");
        effectiveLength -= 2;
        i = seq.length;
      }
    }
  }
  if (/^(19|20)\d{2}$/.test(password.slice(-4)) && password.length < 12) {
    warnings.push("Ends with a year");
    effectiveLength -= 2;
  }
  if (password.length < 8) warnings.push("Shorter than 8 characters");

  const entropyBits = Math.max(0, Math.round(Math.max(effectiveLength, 0) * Math.log2(pool || 1)));
  const score: StrengthScore =
    entropyBits < 28 ? 0 : entropyBits < 40 ? 1 : entropyBits < 60 ? 2 : entropyBits < 80 ? 3 : 4;
  const labels = ["Very weak", "Weak", "Fair", "Strong", "Very strong"] as const;
  return { score, label: labels[score], entropyBits, warnings: [...new Set(warnings)] };
}
