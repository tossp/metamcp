export const SENTRY_DSN_SCRIPT_ID = "metamcp-sentry-dsn";

export function serializeSentryDsn(dsn: string) {
  return JSON.stringify({ dsn }).replace(
    /[<>&\u2028\u2029]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function parseSentryDsn(json: string): string | undefined {
  try {
    const value: unknown = JSON.parse(json);
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !("dsn" in value) ||
      typeof value.dsn !== "string" ||
      !value.dsn.trim()
    ) {
      return undefined;
    }
    const dsn = value.dsn.trim();
    const url = new URL(dsn);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      !url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/\/\d+$/.test(url.pathname)
    ) {
      return undefined;
    }
    return dsn;
  } catch {
    return undefined;
  }
}

export function getBrowserSentryDsn(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const script = document.getElementById(SENTRY_DSN_SCRIPT_ID);
  if (
    !(script instanceof HTMLScriptElement) ||
    script.type !== "application/json" ||
    script.textContent === null
  ) {
    return undefined;
  }
  return parseSentryDsn(script.textContent);
}
