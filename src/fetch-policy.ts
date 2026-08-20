// Cloudflare Workers only implements "follow" and "manual" redirect modes.
// Use manual for credential-bearing upstream requests, then reject 3xx at each
// call site so credentials are never forwarded to a redirect destination.
export const SAFE_FETCH_REDIRECT: RequestRedirect = "manual";

export function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}
