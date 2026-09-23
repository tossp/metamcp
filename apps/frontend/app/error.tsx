"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

import { initializeSentry } from "../components/providers/sentry-provider";

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ErrorPage({ error, reset }: ErrorPageProps) {
  useEffect(() => {
    initializeSentry();
    Sentry.captureException(error);
  }, [error]);

  return (
    <main>
      <h1>Something went wrong</h1>
      <button type="button" onClick={() => reset()}>
        Try again
      </button>
    </main>
  );
}
