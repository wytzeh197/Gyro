// Format guidance only: native code verifies the pinned issuer and Supabase
// decides whether a code or original verification link is valid.
export const CLOUD_SIGNIN_PROOF_MAX_LENGTH = 4096;
export const CLOUD_SIGNIN_PROOF_PATTERN = String.raw`\s*(?:[0-9]{6}|[0-9]{8}|https://[^\s]+)\s*`;
const proofPattern = new RegExp(`^(?:${CLOUD_SIGNIN_PROOF_PATTERN})$`, "u");
export function isCloudSignInProof(value: string) {
  return (
    value.length <= CLOUD_SIGNIN_PROOF_MAX_LENGTH && proofPattern.test(value)
  );
}
