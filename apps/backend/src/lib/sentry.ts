import * as Sentry from "@sentry/node";

export function createSentryOptions(dsn: string): Sentry.NodeOptions {
  return {
    dsn,
    tunnel: "https://cat.tossp.com/e",
    integrations: (defaultIntegrations) => [
      ...defaultIntegrations.filter(
        (integration) =>
          integration.name !== "Http" && integration.name !== "Express",
      ),
      Sentry.httpIntegration({
        breadcrumbs: false,
        maxRequestBodySize: "none",
      }),
      Sentry.expressIntegration(),
    ],
    dataCollection: {
      userInfo: true,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      graphQL: { document: false, variables: false },
      stackFrameVariables: false,
    },
    tracesSampler: ({ parentSampled }) => {
      if (parentSampled !== undefined) {
        return parentSampled ? 1 : 0;
      }

      return process.env.NODE_ENV === "production" ? 0.1 : 0;
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
    // v11 streams spans separately; beforeSend only filters error events.
    beforeSendSpan(span) {
      for (const key of Object.keys(span.attributes)) {
        if (key.startsWith("user.") && key !== "user.ip_address") {
          delete span.attributes[key];
        }
      }
      return span;
    },
  };
}
