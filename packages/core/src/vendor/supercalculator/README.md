Source: https://github.com/SuperCmdLabs/SuperCalculator
Revision: 2568588b4633f3f469c4d46d215382ec64b92baf
License: MIT, see LICENSE in this directory.

The unit and currency data files are copied directly from upstream. Bay uses its
existing arithmetic parser and adapts the fiat provider requests in ../../currency.ts.
Bay adds dated-rate validation, bounded caching, request deduplication and timeouts,
and excludes upstream's static exchange-rate fallback. Crypto, dates and time zones
are outside this integration.

Local table changes preserve Bay's exact volume and speed factors and legacy time
aliases, avoid cancellation error at freezing points, distinguish mega and milli
SI symbols, and guard currency alias lookups against inherited object properties.
