# What Bay contacts, and why

Every web address written into Bay's own code (the app, its native modules and its engine code) is listed here.
`apps/browser/src/privacyEndpoints.test.mjs` fails when a new one isn't, so this page stays complete. Pages you
open, and the extensions you install, contact whatever they contact. So do plugins you add (Settings › Plugins), but
only the hosts their manifest lists, which Bay shows before you add one, and never with your cookies
([plugins.md](plugins.md)). This list covers only what Bay itself does.

Reserved example names (`example.com`, `*.test`, `*.example`, `localhost`) don't count. Neither do three kinds of
file that only name sites: `packages/core/src/bangList.ts` (search shortcuts, opened only when you type one),
`packages/core/src/siteSearch.ts` (site searches, the same) and the icon name tables (`lucideSymbols.web.ts`).

## Bay's own services

| Host | When | Why |
| --- | --- | --- |
| baybrowser.in | Sharing a folder, split or Easel; sending diagnostics when you've turned sharing on; at launch and every six hours | Bay's website: shared links, the opt-in usage and error collector, and the signed list of features a release turned off (`switches.json`) |
| bay.krishkalaria.in | Opening an old shared link | Bay's former website address, for links shared before the move |
| github.com | Checking for updates | Bay's releases and its update feed (appcast) |
| bay-sync.codewithkrish12.workers.dev | Syncing with your phone or another computer through the relay | Bay's sync relay: keeps your synced files, sealed on your device so the relay can't read them |

## Services you turn on or choose

| Host | When | Why |
| --- | --- | --- |
| suggestqueries.google.com | Typing in the address bar, with suggestions on and Google as your engine | Search suggestions |
| api.bing.com | The same, with Bing | Search suggestions |
| duckduckgo.com | The same, with DuckDuckGo; searching | Search suggestions and searches |
| ac.ecosia.org | The same, with Ecosia | Search suggestions |
| suggest.yandex.com | The same, with Yandex | Search suggestions |
| search.brave.com | The same, with Brave Search | Search suggestions and searches |
| search.yahoo.com | The same, with Yahoo | Search suggestions and searches |
| www.startpage.com | The same, with Startpage | Search suggestions and searches |
| www.baidu.com | The same, with Baidu | Search suggestions and searches |
| www.google.com, www.bing.com, www.ecosia.org, yandex.com, kagi.com, www.perplexity.ai, chatgpt.com | Searching with that engine | The search engines Bay offers |
| services.helium.imput.net | Using DuckDuckGo-style search shortcuts | The list of shortcuts (bangs) |
| open.er-api.com, api.frankfurter.dev, cdn.jsdelivr.net | Converting currencies in the command bar | Exchange rates |
| chromewebstore.google.com, clients2.google.com | Adding or updating extensions; importing another browser's extensions | The Chrome Web Store and its download service |
| accounts.google.com, oauth2.googleapis.com, www.googleapis.com | Connecting Google Calendar or Drive | Sign-in and the calendar and Drive data the live folders and meeting groups show |
| api.github.com, github.com | Connecting a GitHub live folder | Pull requests and their previews |
| api.notion.com | Connecting a Notion live folder | Its pages |
| gitlab.com | Connecting a GitLab live folder (or the self-managed GitLab site you enter instead) | Its merge requests and their pipelines |
| api.bitbucket.org, bitbucket.org | Connecting a Bitbucket live folder | Its pull requests |
| chrome.cloudflare-dns.com, dns.quad9.net, dns.google, dns.mullvad.net, dns.nextdns.io | Choosing that provider in Settings › Privacy › Secure DNS | DNS over HTTPS |

## Named, not contacted

| Host | Where | Why |
| --- | --- | --- |
| docs.new, sheets.new, slides.new, forms.new, word.new, excel.new, powerpoint.new, figma.new, figjam.new, gist.new, repo.new, jira.new, confluence.new, linear.new, notion.new, meet.new, meeting.new | Command bar's quick create | Opened when you pick one |
| mail.google.com, calendar.google.com, docs.google.com, drive.google.com, app.slack.com, linear.app, www.figma.com, www.notion.so, open.spotify.com, outlook.office.com, www.youtube.com, github.com | First launch's site picker, previews | Sites you can pin; opened when you pick one |
| www.atlassian.com, your-team.atlassian.net | Live folder setup | A link and a placeholder |
| www.netflix.com | Settings › Engines | The streaming row's icon (its favicon, as for any site) |
| en.wikipedia.org | Settings › Search | A placeholder |
| learn.microsoft.com, mozilla.org, www.w3.org, url.spec.whatwg.org | Code comments, the SVG namespace | References |
| a.com, b.com | An engine comment | Examples |
| www.apple.com | The .webloc files a shared folder holds | Their XML names Apple's property list DTD, as every .webloc does; nothing fetches it |
