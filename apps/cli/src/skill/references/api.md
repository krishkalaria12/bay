# The `bay exec` API

Every method returns a promise (`await` it). Timeouts are in milliseconds.

## In scope

| Name | What it is |
| --- | --- |
| `tab` | The page the user is looking at when the run starts. Any use raises `NoPageTab` when there's none. |
| `tabs` | Every web page tab when the run starts, plus the ones `newTab` opens. |
| `newTab(url = "about:blank", background = true)` | Opens a tab in the sidebar and waits for the load. `background: false` switches the user to it. Also `new_tab`. |
| `js(expression, tab?)` | `tab.evaluate(expression)` on `tab`, else the user's tab, else the last tab `newTab` opened. |
| `pinned()` | The user's favorites and pinned tabs: `{ title, url, pinnedUrl, kind: "favorite" \| "pinned", folder, space, parked }`. |
| `history({ days = 1, limit = 200, space, domains = false })` | Visits, newest first: `{ url, title, visits, total_visits, last_visit, space }`, or per domain with `domains: true`: `{ domain, visits, pages, last_visit, top_title, space }`. `limit: null` for all. |
| `browser` | The connection. `await browser.getTargets()` lists every page target. |
| `Key` | Key names for `pressKey`: `ENTER`, `TAB`, `ESCAPE`, `BACKSPACE`, `DELETE`, `ARROW_LEFT`/`UP`/`RIGHT`/`DOWN`, `HOME`, `END`, `PAGE_UP`, `PAGE_DOWN`, `SPACE`. |

## Tab

| Call | What it does |
| --- | --- |
| `goto(url, { timeout = 30000, waitUntil = "load" })` | Navigate and wait for the load (`waitUntil: "none"` returns at once). Raises `NavigationError`, `PageLoadTimeout`. |
| `reload({ timeout })` | Load the current URL again and wait. |
| `url()`, `title()`, `pageSource()` | The URL, the title, the HTML. |
| `evaluate(expression, { awaitPromise = true, returnByValue = true, timeoutMs = 15000 })` | `js()` without the tab fallback. A JavaScript error raises `ScriptEvaluationError`. |
| `query(selector, { timeout = 0, raiseExc = true })` | CSS, or XPath when it starts with `/` or `(`. Not found: `ElementNotFound` (`timeout: 0`), `WaitElementTimeout` (with a timeout), `null` (`raiseExc: false`). |
| `queryAll(selector, options)` | Every match, as `Element[]`; waits for at least one with a timeout. |
| `find({ tagName, id, className, name, text, timeout, raiseExc, ...attributes })` / `findAll(...)` | Builds the selector. `id` alone decides; `text` (contained, whitespace collapsed) goes with `tagName` only; otherwise every attribute must match, `dataTestid: "x"` being `data-testid="x"`. |
| `click(selector, options)`, `type(selector, text, options)` | `query`, then the element's `click()` / `typeText()`. |
| `pressKey(key)` | One key, by name (`"Enter"`, `Key.TAB`) or a single character, to the focused element. |
| `waitForUrl(pattern, timeout = 30000)` | Until the URL matches the wildcard (`*` any run of characters, `?` one): `"**?q=*"`. Returns the URL. |
| `waitForScript(expression, timeout = 10000)` | Until the expression is truthy; returns its value. |
| `waitForNetworkIdle({ timeout = 30000, idle = 500 })` | No requests in flight for `idle` ms. |
| `expectNavigation(action, timeout = 30000)` | Runs `action`, then waits for the page it loads. |
| `screenshot(path, { fullPage = false })` | PNG to `path`; returns the path. Works on background tabs. |
| `pdf(path)` | PDF of the page; returns the path. |
| `activate()` | Shows the tab to the user. Only when they asked. |
| `close()` | Closes the tab. Only the ones you opened. |
| `send(method, params)` | A raw DevTools command on the tab's session, within what Bay allows. |

## Element

| Call | What it does |
| --- | --- |
| `click()` | A real mouse click at its centre, after scrolling it into view. |
| `typeText(text)` | Focuses it and types `text` as real input; a trailing `"\r"` presses Enter, which submits a form. |
| `pressKey(key)` | Focuses it, then one key. |
| `focus()` | Focuses it. |
| `text()`, `getAttribute(name)` | Its `innerText`; an attribute or `null`. |
| `exists()`, `isVisible()` | Whether it's still in the page; whether it has a size and isn't hidden. |
| `waitUntil({ visible = true, timeout = 10000 })` | Until it's visible (or hidden with `visible: false`). Raises `WaitTimeout`. |
| `screenshot(path)` | PNG of just the element. |

## Errors

`NoPageTab`, `ElementNotFound`, `WaitElementTimeout`, `WaitTimeout`, `PageLoadTimeout`, `NavigationError`,
`ScriptEvaluationError` and `BrowsingDataError` (from `pinned` and `history`) are in scope, for `instanceof` checks.
