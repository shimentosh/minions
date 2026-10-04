/** Parses `.env` content into ordered key/value pairs. Comments and blanks are skipped. */
export function parseDotenv(text: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2]!;
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    out.push({ key: m[1]!, value });
  }
  return out;
}

export function toDotenv(pairs: { key: string; value: string }[]): string {
  return pairs
    .map(({ key, value }) => {
      const needsQuotes = /[\s#"'\\]/.test(value) || value.includes("\n");
      return `${key}=${needsQuotes ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"` : value}`;
    })
    .join("\n");
}
