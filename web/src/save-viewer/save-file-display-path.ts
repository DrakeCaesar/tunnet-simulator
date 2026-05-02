/** Optional host extension (e.g. Electron). Standard browsers do not set this. */
export function absolutePathFromFile(file: File): string | undefined {
  const p = (file as File & { path?: string }).path;
  if (typeof p !== "string") return undefined;
  const t = p.trim();
  return t.length > 0 ? t.replace(/\//g, "\\") : undefined;
}

/**
 * Friendly Windows-style labels similar to env vars (%AppData%, etc.).
 * Only applies to typical `C:\...` (and `\\?\`-prefixed) absolute paths.
 */
export function shortenWindowsPathForDisplay(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  let p = trimmed.replace(/\//g, "\\");
  if (p.startsWith("\\\\?\\")) {
    p = p.slice(4);
  }
  if (!/^[a-zA-Z]:\\/.test(p)) {
    return trimmed;
  }

  const mDrive = p.match(/^([a-zA-Z]:)(\\.*)$/);
  if (!mDrive) return p;
  const rest = mDrive[2] ?? "";

  if (/^\\ProgramData(\\|$)/i.test(rest)) {
    return `%ProgramData%${rest.replace(/^\\ProgramData/i, "")}`;
  }

  const mUsers = rest.match(/^\\Users\\([^\\]+)(.*)$/i);
  if (!mUsers) return p;
  const segment = mUsers[1]!;
  const tail = mUsers[2] ?? "";

  if (segment.toLowerCase() === "public") {
    return `%Public%${tail}`;
  }

  if (/^\\AppData\\Roaming(\\|$)/i.test(tail)) {
    return `%AppData%${tail.replace(/^\\AppData\\Roaming/i, "")}`;
  }
  if (/^\\AppData\\Local\\Temp(\\|$)/i.test(tail)) {
    return `%Temp%${tail.replace(/^\\AppData\\Local\\Temp/i, "")}`;
  }
  if (/^\\AppData\\Local(\\|$)/i.test(tail)) {
    return `%LocalAppData%${tail.replace(/^\\AppData\\Local/i, "")}`;
  }

  return `%UserProfile%${tail}`;
}

export function displaySaveLocation(opts: { fileName: string; absolutePath?: string }): { label: string; title: string } {
  const raw = opts.absolutePath?.trim();
  const title = raw && raw.length > 0 ? raw.replace(/\//g, "\\") : opts.fileName;
  const label = raw && raw.length > 0 ? shortenWindowsPathForDisplay(raw) : opts.fileName;
  return { label, title };
}
