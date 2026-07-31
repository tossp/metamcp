export const APP_URL_SCRIPT_ID = "metamcp-app-url";

const escapeJsonForHtml = (json: string) =>
  json.replace(
    /[<>&\u2028\u2029]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

export const serializeAppUrl = (appUrl: string) =>
  escapeJsonForHtml(JSON.stringify({ appUrl }));

export const parseAppUrl = (json: string) => {
  try {
    const value: unknown = JSON.parse(json);

    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !("appUrl" in value) ||
      typeof value.appUrl !== "string"
    ) {
      return undefined;
    }

    const url = new URL(value.appUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }

    return value.appUrl;
  } catch {
    return undefined;
  }
};

export const getAppUrl = () => {
  if (typeof window === "undefined") {
    const appUrl = process.env.APP_URL;
    if (appUrl) {
      return appUrl;
    }

    throw new Error("APP_URL environment variable is required but not set");
  }

  const script = document.getElementById(APP_URL_SCRIPT_ID);
  if (
    !(script instanceof HTMLScriptElement) ||
    script.type !== "application/json" ||
    script.textContent === null
  ) {
    return window.location.origin;
  }

  return parseAppUrl(script.textContent) ?? window.location.origin;
};
