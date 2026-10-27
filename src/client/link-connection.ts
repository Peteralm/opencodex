/**
 * The last tunnel connection a Home-initiated link's Home proved to this Child (relay-auth.ts).
 * Updated by every verified relay preflight; process memory only, so a restart forgets it.
 */
const verified = new Map<string, string>();

export function recordVerifiedHomeConnection(linkId: string, generation: string): void {
  verified.set(linkId, generation);
}

export function verifiedHomeConnection(linkId: string): string | undefined {
  return verified.get(linkId);
}
