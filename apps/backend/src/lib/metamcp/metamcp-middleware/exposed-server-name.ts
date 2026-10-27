/**
 * Keep identical to sanitizeName in ../utils.ts (the proxy's public prefix).
 * This pure helper avoids importing utils and its database/pool dependencies.
 */
export function exposedServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "");
}
