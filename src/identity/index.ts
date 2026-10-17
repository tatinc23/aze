import type { Attestation } from "../types.js";

/**
 * Identity attestation for a filer. Inkbox principal-blind verification is unconfirmed; this is the seam.
 * Until it is, every note is 'unverified' regardless of the proof sent.
 */
export async function attest(_proof: string | undefined): Promise<Attestation> {
  return "unverified";
}
