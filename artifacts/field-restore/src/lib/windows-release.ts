export interface WindowsRelease {
  filename: string;
  version: string;
  sha256: string;
  unsigned: boolean;
  publisher: string | null;
  nativeWindowsTested: boolean;
}

const SAFE_EXE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,120}\.exe$/i;

// Metadata describes a release; it does not verify Authenticode in the browser.
export function parseWindowsRelease(value: unknown): WindowsRelease | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.filename !== 'string' || typeof r.version !== 'string' || typeof r.sha256 !== 'string') return null;
  if (typeof r.unsigned !== 'boolean') return null;
  if (!SAFE_EXE.test(r.filename) || r.filename.includes('..')) return null;
  if (!/^[A-Fa-f0-9]{64}$/.test(r.sha256)) return null;
  if (!r.version.trim() || r.version.length > 40) return null;
  const publisher = typeof r.publisher === 'string' && r.publisher.trim() &&
    r.publisher.length <= 200 && !/[\u0000-\u001f\u007f]/.test(r.publisher)
    ? r.publisher.trim() : null;
  return {
    filename: r.filename,
    version: r.version,
    sha256: r.sha256.toLowerCase(),
    unsigned: r.unsigned,
    publisher: r.unsigned ? null : publisher,
    nativeWindowsTested: r.nativeWindowsTested === true,
  };
}