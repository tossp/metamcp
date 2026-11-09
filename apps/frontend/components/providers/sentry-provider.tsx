"use client";

import * as Sentry from "@sentry/nextjs";

import { getBrowserSentryDsn } from "../../lib/sentry-env";
import { getBrowserSentryOptions } from "../../lib/sentry-options";

let sentryInitialized = false;

export function initializeSentry() {
  const sentryDsn = getBrowserSentryDsn();
  if (!sentryDsn || sentryInitialized) {
    return;
  }

  Sentry.init(getBrowserSentryOptions(sentryDsn, window.location.origin));
  sentryInitialized = true;
}

export function SentryProvider({ children }: { children: React.ReactNode }) {
  initializeSentry();
  return children;
}
