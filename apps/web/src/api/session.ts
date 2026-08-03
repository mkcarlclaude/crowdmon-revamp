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
 * Where a browser has to go to obtain an Access session.
 *
 * Not the current URL. `/admin` is a static asset with no Access application in
 * front of it (M5.1, CONTEXT.md §Q19: gate the API, not the bundle), so
 * navigating to it returns the SPA shell without ever touching Access. The
 * first version of this function reloaded `window.location.href` and therefore
 * looped forever: reload, re-fetch, fail, show the banner, reload.
 *
 * This path is under `/api/admin`, which the Access application does bind to,
 * so the navigation is intercepted before the Worker sees it. The Worker's
 * handler redirects back to `/admin` once an assertion exists.
 */
const LOGIN_PATH = "/api/admin/login";

/**
 * Send the browser through the Access login flow.
 *
 * It has to be a top-level navigation. `fetch` cannot complete a redirect chain
 * to an identity provider on another origin — that failure is precisely what
 * `SessionExpiredError` is raised from.
 */
export function reauthenticate() {
  window.location.assign(LOGIN_PATH);
}
