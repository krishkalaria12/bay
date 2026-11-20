// The welcome's last moment: skipped early, its glass becomes the search field, and the browser opens the real one in
// its place once the welcome has gone (BrowserScreen takes the request when `welcomed` turns true).

let fieldRequested = false;

/** The welcome ends on the search field. */
export function requestField(): void {
  fieldRequested = true;
}

/** Whether the welcome that just ended asked for the field; asking takes the request. */
export function takeFieldRequest(): boolean {
  const requested = fieldRequested;
  fieldRequested = false;

  return requested;
}
