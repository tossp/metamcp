type OAuthPersistenceResult = { success: boolean; error?: string };

export async function requireOAuthPersistence(
  operation: () => Promise<OAuthPersistenceResult>,
  failureMessage: string,
): Promise<void> {
  const result = await operation();
  if (!result.success) {
    throw new Error(result.error || failureMessage);
  }
}
