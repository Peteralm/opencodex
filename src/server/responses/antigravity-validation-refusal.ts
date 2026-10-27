import { ANTIGRAVITY_VALIDATION_REQUIRED_PREFIX, safeAntigravityHttpErrorMessage } from "../../adapters/google-errors";
import { readBoundedResponseBody } from "../../lib/bounded-body";

/** Match only the normalized Antigravity validation-refusal marker. */
export function hasAntigravityValidationRefusalMarker(text: string): boolean {
  return text.startsWith(`${ANTIGRAVITY_VALIDATION_REQUIRED_PREFIX}: `);
}

/** Inspect only the Google adapter's normalized, already bounded 403 response. */
export async function isAntigravityValidationRefusal(response: Response, signal?: AbortSignal): Promise<boolean> {
  return inspectValidationRefusal(response, signal, false);
}

/** Sidecar dispatch retains the raw Google envelope; normalize only a complete bounded body. */
export async function isAntigravityRawValidationRefusal(response: Response, signal?: AbortSignal): Promise<boolean> {
  return inspectValidationRefusal(response, signal, true);
}

async function inspectValidationRefusal(response: Response, signal: AbortSignal | undefined, raw: boolean): Promise<boolean> {
  if (response.status !== 403 || signal?.aborted) return false;
  try {
    const body = await readBoundedResponseBody(response.clone(), {
      maxBytes: raw ? 4096 : 1024,
      totalTimeoutMs: raw ? 2000 : 1000,
      firstByteTimeoutMs: raw ? 2000 : 1000,
      inactivityTimeoutMs: raw ? 2000 : 1000,
      signal,
    });
    return !signal?.aborted && body.displaySafe && !body.truncated && !body.timedOut && !body.oversized
      && hasAntigravityValidationRefusalMarker(raw ? safeAntigravityHttpErrorMessage(403, body.text) : body.text);
  } catch {
    return false;
  }
}

/** Only a complete, bounded Google CCA model-not-found refusal qualifies for account rotation. */
export async function isAntigravityModelNotFoundRefusal(response: Response, signal?: AbortSignal): Promise<boolean> {
  if (response.status !== 404 || signal?.aborted) return false;
  try {
    const body = await readBoundedResponseBody(response.clone(), {
      maxBytes: 4096, totalTimeoutMs: 2000, firstByteTimeoutMs: 1000, inactivityTimeoutMs: 1000, signal,
    });
    return !signal?.aborted && body.displaySafe && !body.truncated && !body.timedOut && !body.oversized
      && /\bRequested entity was not found\b/i.test(body.text);
  } catch { return false; }
}
