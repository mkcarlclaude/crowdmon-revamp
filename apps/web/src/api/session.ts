/**
 * The Access session has expired, in whichever of its two disguises.
 *
 * Recovery is never a retry. The browser has to complete a redirect flow the
 * `fetch` API cannot, so the only fix is a full-page navigation — which is why
 * this is a distinct type rather than another failed request.
 */
export class SessionExpiredError extends Error {
  constructor() {
    super("your Access session has expired");
    this.name = "SessionExpiredError";
  }
}

/** A response the API refused, carrying its own error contract. */
export class ApiError extends Error {
  readonly status: number;
  readonly issues?: Array<{ path: string; message: string }>;

  constructor(status: number, message: string, issues?: Array<{ path: string; message: string }>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.issues = issues;
  }
}

/**
 * Re-request the current URL as a top-level navigation so the browser can
 * follow Access's redirect chain and land back here logged in.
 *
 * `assign(href)` rather than `reload()`: a reload of a POST-derived history
 * entry re-prompts for resubmission, and the SPA's URL is what we want back.
 */
export function reauthenticate() {
  window.location.assign(window.location.href);
}
