import type { BrowserOptions } from "@sentry/nextjs";

export function getBrowserSentryOptions(
  dsn: string,
  origin: string,
): BrowserOptions {
  return {
    dsn,
    tunnel: "https://cat.tossp.com/e",
    // v11 defaults to broader collection; only user IP collection is enabled.
    dataCollection: {
      userInfo: true,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      graphQL: { document: false, variables: false },
      stackFrameVariables: false,
    },
    tracePropagationTargets: [origin, /^\//],
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 0,
    beforeBreadcrumb(breadcrumb) {
      if (
        breadcrumb.category === "fetch" ||
        breadcrumb.category === "http" ||
        breadcrumb.category === "xhr"
      ) {
        return { ...breadcrumb, data: undefined };
      }

      return breadcrumb;
    },
    beforeSend(event) {
      if (event.user) {
        event.user = event.user.ip_address
          ? { ip_address: event.user.ip_address }
          : undefined;
      }
      if (event.request) {
        event.request = {
          method: event.request.method,
          url: event.request.url?.split("?")[0],
        };
      }
      if (event.contexts) {
        delete event.contexts.response;
      }
      if (event.extra) {
        delete event.extra.request;
        delete event.extra.response;
      }

      return event;
    },
  };
}
