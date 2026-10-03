"use client";

import * as Sentry from "@sentry/nextjs";

import { getBrowserSentryDsn } from "../../lib/sentry-env";

let sentryInitialized = false;

export function initializeSentry() {
  const sentryDsn = getBrowserSentryDsn();
  if (!sentryDsn || sentryInitialized) {
    return;
  }

  Sentry.init({
    dsn: sentryDsn,
    sendDefaultPii: false,
    tracePropagationTargets: [window.location.origin, /^\//],
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
  });
  sentryInitialized = true;
}

export function SentryProvider({ children }: { children: React.ReactNode }) {
  initializeSentry();
  return children;
}
