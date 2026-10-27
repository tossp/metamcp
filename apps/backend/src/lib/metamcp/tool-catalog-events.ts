import logger from "@/utils/logger";

type Listener = (serverUuid: string) => void | Promise<void>;
const listeners = new Set<Listener>();
type InvalidationListener = (
  serverUuid: string,
  revision?: number,
) => void | Promise<void>;
const invalidationListeners = new Set<InvalidationListener>();

export function subscribeCatalogInvalidation(
  listener: InvalidationListener,
): () => void {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
}

/** Await invalidation when a saved credential/configuration is replaced. */
export async function invalidateCatalogConnections(
  serverUuid: string,
  revision?: number,
): Promise<void> {
  await Promise.all(
    [...invalidationListeners].map((listener) =>
      listener(serverUuid, revision),
    ),
  );
}

export function subscribeToolCatalog(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Only publish after the new directory has committed successfully. */
export function notifyToolCatalogChanged(serverUuid: string): void {
  for (const listener of listeners) {
    void Promise.resolve()
      .then(() => listener(serverUuid))
      .catch(() => logger.warn("Tool catalog change notification failed"));
  }
}
