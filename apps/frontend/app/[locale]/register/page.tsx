"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";

import { DomainWarningBanner } from "@/components/domain-warning-banner";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { useTranslations } from "@/hooks/useTranslations";
import { authClient } from "@/lib/auth-client";
import {
  getLocalRegistrationPolicy,
  loadLocalAuthPolicy,
  RegistrationPolicy,
} from "@/lib/local-auth-policy";
import { vanillaTrpcClient } from "@/lib/trpc";

function LoadingFallback() {
  const { t } = useTranslations();
  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("common:loading")}
        </h1>
      </div>
    </div>
  );
}

function RegisterForm() {
  const { t } = useTranslations();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [registrationPolicy, setRegistrationPolicy] =
    useState<RegistrationPolicy | null>(null);

  const router = useRouter();

  const checkSignupStatus =
    useCallback(async (): Promise<RegistrationPolicy> => {
      const policy = await loadLocalAuthPolicy(
        vanillaTrpcClient.frontend.config,
      );
      const currentPolicy = getLocalRegistrationPolicy(policy);
      setRegistrationPolicy(currentPolicy);
      return currentPolicy;
    }, []);

  useEffect(() => {
    void checkSignupStatus();
  }, [checkSignupStatus]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    setIsLoading(true);
    setError("");

    try {
      // Use the freshly returned policy, not the previous render's state.
      const currentPolicy = await checkSignupStatus();
      if (currentPolicy !== "allowed") return;

      if (password !== confirmPassword) {
        setError(t("auth:passwordsDoNotMatch"));
        return;
      }

      if (password.length < 8) {
        setError(t("auth:passwordTooShort"));
        return;
      }

      const { error } = await authClient.signUp.email({
        email,
        password,
        name,
        callbackURL: "/",
      });

      if (error) {
        const currentPolicy = await checkSignupStatus();
        if (currentPolicy === "allowed") {
          setError(error.message || t("auth:registrationFailed"));
        }
      } else {
        router.push("/");
        router.refresh();
      }
    } catch (err) {
      console.error("Registration error:", err);
      const currentPolicy = await checkSignupStatus();
      if (currentPolicy === "allowed") {
        setError((err as Error)?.message || t("auth:registrationFailed"));
      }
    } finally {
      setIsLoading(false);
    }
  };

  if (registrationPolicy === null) {
    return (
      <div className="space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("common:loading")}
          </h1>
        </div>
      </div>
    );
  }

  if (registrationPolicy !== "allowed") {
    return (
      <div className="space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t(
              registrationPolicy === "unavailable"
                ? "auth:registrationFailed"
                : "auth:registrationDisabled",
            )}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t(
              registrationPolicy === "basic-auth-disabled"
                ? "auth:basicAuthDisabledMessage"
                : registrationPolicy === "unavailable"
                  ? "auth:registrationFailed"
                  : "auth:registrationDisabledMessage",
            )}
          </p>
        </div>
        <div className="text-center text-sm">
          <span className="text-muted-foreground">
            {t("auth:alreadyHaveAccount")}{" "}
          </span>
          <Link href="/login" className="underline underline-offset-4">
            {t("auth:signIn")}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("auth:createAccount")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("auth:enterAccountDetails")}
        </p>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/15 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <label htmlFor="name" className="text-sm font-medium">
            {t("auth:name")}
          </label>
          <Input
            id="name"
            name="name"
            type="text"
            autoComplete="name"
            placeholder={t("auth:namePlaceholder")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            disabled={isLoading}
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="email" className="text-sm font-medium">
            {t("auth:email")}
          </label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder={t("auth:emailPlaceholder")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={isLoading}
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="password" className="text-sm font-medium">
            {t("auth:password")}
          </label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            placeholder={t("auth:passwordPlaceholder")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={isLoading}
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="confirmPassword" className="text-sm font-medium">
            {t("auth:confirmPassword")}
          </label>
          <Input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            placeholder={t("auth:confirmPasswordPlaceholder")}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            disabled={isLoading}
          />
        </div>

        <Button type="submit" className="w-full" disabled={isLoading}>
          {isLoading
            ? t("auth:creatingAccount")
            : t("auth:createAccountButton")}
        </Button>
      </form>

      <div className="text-center text-sm">
        <span className="text-muted-foreground">
          {t("auth:alreadyHaveAccount")}{" "}
        </span>
        <Link href="/login" className="underline underline-offset-4">
          {t("auth:signIn")}
        </Link>
      </div>
    </div>
  );
}

export default function RegisterPage() {
  return (
    <div className="relative min-h-screen flex items-center justify-center px-4">
      <div className="absolute top-4 right-4 flex items-center gap-2">
        <ThemeToggle />
        <LanguageSwitcher />
      </div>
      <div className="w-full max-w-sm mx-auto flex flex-col justify-center space-y-6">
        <DomainWarningBanner />
        <Suspense fallback={<LoadingFallback />}>
          <RegisterForm />
        </Suspense>
      </div>
    </div>
  );
}
