---
name: bay
description: Drive the user's running Bay browser from the terminal with `bay exec` (TypeScript/JavaScript over the Chrome DevTools Protocol). Use when a task needs a real browser with the user's logins, to read the page the user is looking at, open pages, click, type, take screenshots or run JavaScript; to write, test and install userscripts that change how sites look or behave; or to set up and run a daily report built from the sites the user pins and visits.
---

# Driving Bay with `bay exec`

`bay exec` runs TypeScript/JavaScript against the Bay the user has open, with top-level `await`. The value of the last
expression is printed: strings as they are, anything else inspected, or JSON with `--json`. Every run is a new
process, so carry state between runs in a URL or a file, not a variable.

```sh
bay exec 'await tab.title()'
bay exec --json 'await Promise.all(tabs.map(t => t.url()))'
bay exec -f script.ts
```

In scope:

- `tab`: the web page the user is looking at when the run starts, even with Bay's window covered. When they're on
  New Tab or another Bay view, any use of `tab` raises `NoPageTab`: open a page with
  `newTab` instead.
- `tabs`: every web page tab when the run starts, the user's own included, plus the ones `newTab` opens.
- `newTab(url, background=true)`: opens a tab in the sidebar, waits for the page to load and returns it.
  `background=false` switches the user to it. (Also available as `new_tab`).
- `js(expression, tab=null)`: evaluates JavaScript and returns its value. Pass `tab=t` for your own tab; without
  it, `js` uses the user's tab, else the last tab you opened, else raises `NoPageTab`.
- `browser`, `Key`, `ElementNotFound`, `WaitElementTimeout` and other exports.

Exit status: 0 done, 1 your code raised or timed out (`--timeout`, default 300 s), 2 Bay can't be reached or
stopped the connection.
On exit 2, tell the user to open Bay and turn on Settings › "Let the bay command control Bay".

## Etiquette

This is the user's own browser, signed in to their accounts.

- Do your work in a tab you open with `newTab`. Read the user's `tab`, but don't navigate it unless they ask.
- Close only the tabs you opened (`await t.close()`), and only when you're done with them.
- Delete the scratch scripts you wrote; keep the files the user asked for (screenshots, exports).
- Ask before anything with consequences: submitting forms, sending messages, posting, buying, deleting,
  changing settings or accepting dialogs.
- Don't read or export cookies, passwords or storage unless the user asks for exactly that.

## Recipes

Read the page the user is on (raises `NoPageTab` on New Tab):

```sh
bay exec '[await tab.url(), await tab.title()]'
bay exec 'await js("document.body.innerText.slice(0, 5000)")'
```

Open a page and work there. Every run starts over, so find your tab again by URL:

```sh
bay exec 'const t = await newTab("https://example.com"); await js("document.links[0].href", t)'
```

Longer work goes in a file. Close your tab, then put the data on the last line so it's printed:

```ts
const t = await newTab("https://news.ycombinator.com");
const rows = await js("[...document.querySelectorAll('.titleline > a')].slice(0, 3).map(a => [a.innerText, a.href])", t);
await t.screenshot("/tmp/hn.png");
await t.close();
rows;
```

```sh
bay exec --json -f /tmp/hn.ts && rm /tmp/hn.ts
```

Find, click and type:

```ts
const t = await newTab("https://example.com/search");
const box = await t.query('input[name="q"]', { timeout: 10_000 });
await box.typeText("bay browser\r");
await t.waitForUrl("**?q=*", 15_000);
const results = await t.queryAll("h3");
await Promise.all(results.slice(0, 5).map(r => r.text()));
```

`query` takes CSS or XPath; `find({ tagName, id, className, name, text, ...attributes })` builds
the selector for you. Both wait up to `timeout` milliseconds for the element. When it isn't there they raise
`ElementNotFound` (with `timeout: 0`, the default) or `WaitElementTimeout` (with a timeout), or return `null` with
`raiseExc: false`. For a click that loads a new page:

```ts
await t.expectNavigation(async () => {
  await (await t.find({ tagName: "a", text: "Next" })).click();
});
```

Wait for things:

```ts
await (await t.query("#results", { timeout: 10_000 })).waitUntil({ visible: true, timeout: 10_000 });
await t.waitForScript("document.readyState === 'complete'", 10_000);
await t.waitForNetworkIdle({ timeout: 15_000 });
```

Screenshots and PDFs go to a file:

```sh
bay exec 'await tab.screenshot("/tmp/page.png"); "/tmp/page.png"'
bay exec 'await tab.screenshot("/tmp/full.png", { fullPage: true })'
bay exec 'const el = await tab.query("main"); await el.screenshot("/tmp/main.png")'
bay exec 'await tab.pdf("/tmp/page.pdf")'
```

Run JavaScript: `js()` returns plain values (awaiting promises) and raises on a JavaScript error.

```sh
bay exec --json 'await js("[...document.links].slice(0, 20).map(a => ({ text: a.innerText, href: a.href }))")'
```

## Userscripts

When the user wants a site to look or behave differently every time they visit it, write a userscript instead of
driving the page by hand. `bay scripts` takes TypeScript or JavaScript with a Violentmonkey `==UserScript==` header,
so existing `.user.js` files work too. `bay scripts --help` and each command's `--help` explain the details.

- Start from `bay scripts new`, or from a script the user already has.
- Read the real page before writing selectors, and keep the script small and robust to the site changing.
- Iterate with `bay scripts test` until it passes cleanly on the pages it targets. It runs in a tab of its own and
  reports what ran, what logged and what threw.
- Install only once the user is happy with it. `bay scripts list` and `uninstall` manage what's installed.

## Daily reports

Once you know Bay works, ask the user whether they'd like a daily report. If they say no, drop it. If they say
yes, ask what they care about most and when they want it, then set it up so it runs on its own each day (your
harness's scheduler if it has one, otherwise the system's). Save what you agreed on where the scheduled run can read
it.

Each report starts from what the user actually uses. `await pinned()` returns their pinned tabs and favorites, and
`await history()` returns what they visited recently. Visit the sites that matter in tabs of your own, using their
logins, and only read: never reply, mark as read, accept or send anything. By default the report covers what's
pending for them and what changed on things they finished or are waiting on since the last report. Shape it around
their priorities, keep it short, and deliver it the way they asked. Keep enough state between runs to tell new from
old.

## Gotchas

- Every tab and element method returns a promise: `await tab.title()`, `await el.text()`. `Promise.all` runs
  several at once; `tabs.map(t => t.url())` alone gives promises, not URLs.
- The full API, with every option and default, is in `references/api.md`. Timeouts are in milliseconds.
- `bay exec` refuses `Browser.close` and the other browser-wide commands. It never quits Bay.
- It reaches web pages only (http, https, `about:blank`, `data:`, `blob:`), not `file://`, `chrome://`, extension
  pages or Bay's own views. Bay also refuses DevTools calls that read cookies, storage or saved data, change
  browser settings or permissions, intercept requests or touch local files; those fail with
  `bay: <Method> isn't allowed for the bay command`.
- Background tabs stay behind the user's page. Clicks and typing still reach them, and screenshots work.
- Type with `typeText` (real input) when a page listens for it. To press Enter in a field, end the text with `"\r"`
  or call the element's `pressKey(Key.ENTER)`; the tab's `pressKey` goes to whatever has focus.
