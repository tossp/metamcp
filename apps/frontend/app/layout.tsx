import "./globals.css";

import type { Metadata } from "next";
import localFont from "next/font/local";
import { connection } from "next/server";
import { Toaster } from "sonner";

import { ThemeProvider } from "../components/providers/theme-provider";
import { TRPCProvider } from "../components/providers/trpc-provider";
import { APP_URL_SCRIPT_ID, getAppUrl, serializeAppUrl } from "../lib/env";

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

  return (
    <html suppressHydrationWarning>
      <head>
        <script
          id={APP_URL_SCRIPT_ID}
          type="application/json"
          dangerouslySetInnerHTML={{ __html: serializedAppUrl }}
        />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <ThemeProvider>
          <TRPCProvider>
            {children}
            <Toaster richColors position="top-right" closeButton />
          </TRPCProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
