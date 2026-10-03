import "./globals.css";

import type { Metadata } from "next";
import localFont from "next/font/local";
import { connection } from "next/server";
import { Toaster } from "sonner";

import { SentryProvider } from "../components/providers/sentry-provider";
import { ThemeProvider } from "../components/providers/theme-provider";
import { TRPCProvider } from "../components/providers/trpc-provider";
import { APP_URL_SCRIPT_ID, getAppUrl, serializeAppUrl } from "../lib/env";
import { SENTRY_DSN_SCRIPT_ID, serializeSentryDsn } from "../lib/sentry-env";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  title: "MetaMCP",
  description:
    "MetaMCP is dev platform for dynamically configuring and deploying MCPs",
};

interface RootLayoutProps {
  children: React.ReactNode;
}

export default async function RootLayout({ children }: RootLayoutProps) {
  await connection();
  const serializedAppUrl = serializeAppUrl(getAppUrl());
  // Read at request time; direct NEXT_PUBLIC env access is inlined at build time.
  const runtimeEnv = process.env;
  const serializedSentryDsn = serializeSentryDsn(
    runtimeEnv.NEXT_PUBLIC_SENTRY_DSN?.trim() ?? "",
  );

  return (
    <html suppressHydrationWarning>
      <head>
        <script
          id={APP_URL_SCRIPT_ID}
          type="application/json"
          dangerouslySetInnerHTML={{ __html: serializedAppUrl }}
        />
        <script
          id={SENTRY_DSN_SCRIPT_ID}
          type="application/json"
          dangerouslySetInnerHTML={{ __html: serializedSentryDsn }}
        />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <SentryProvider>
          <ThemeProvider>
            <TRPCProvider>
              {children}
              <Toaster richColors position="top-right" closeButton />
            </TRPCProvider>
          </ThemeProvider>
        </SentryProvider>
      </body>
    </html>
  );
}
