import { readFileSync } from "node:fs";

interface EndpointRow {
  address: string;
}

interface NormalizedData {
  endpoints: EndpointRow[];
}

function isValidBase4Address(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^[0-3]$/.test(p));
}

function hasPresentInSubtree(
  present: Set<string>,
  prefix: number[],
  depth: number,
): boolean {
  const recur = (buf: number[], d: number): boolean => {
    if (d === 4) {
      return present.has(buf.join("."));
    }
    for (let v = 0; v < 4; v += 1) {
      buf[d] = v;
      if (recur(buf, d + 1)) return true;
    }
    return false;
  };
  const buf = [...prefix];
  while (buf.length < 4) buf.push(0);
  return recur(buf, depth);
}

function emitMissingRanges(
  present: Set<string>,
  prefix: number[],
  depth: number,
  out: string[],
): void {
  const subtreeHasPresent = hasPresentInSubtree(present, prefix, depth);
  if (!subtreeHasPresent) {
    const pattern = [...prefix.map(String)];
    while (pattern.length < 4) pattern.push("*");
    out.push(pattern.join("."));
    return;
  }
  if (depth === 4) {
    return;
  }
  for (let v = 0; v < 4; v += 1) {
    prefix.push(v);
    emitMissingRanges(present, prefix, depth + 1, out);
    prefix.pop();
  }
}

function main(): void {
  const raw = readFileSync("data.normalized.json", "utf8");
  const data = JSON.parse(raw) as NormalizedData;

  const present = new Set<string>(
    data.endpoints
      .map((e) => e.address)
      .filter(isValidBase4Address),
  );

  const ranges: string[] = [];
  emitMissingRanges(present, [], 0, ranges);

  const missingCount = 256 - present.size;

  console.log(`Present addresses: ${present.size}/256`);
  console.log(`Missing addresses: ${missingCount}/256`);
  console.log("Missing ranges:");
  for (const r of ranges) {
    console.log(`- ${r}`);
  }
}

main();
