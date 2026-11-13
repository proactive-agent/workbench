---
name: prefer-browser-native
description: Browser drawer features should behave like the real browser; prefer native browser mechanisms over custom replicas
metadata:
  type: feedback
---

For the browser drawer (embedded chat browsers), prefer browser-native behavior over custom-built replicas: use what the browser or Playwright already does, and only fill gaps where headless or the protocol leaves no native way. When a custom stand-in is unavoidable, make it look and act like the browser's own (e.g. the extension popup shows only the extension's page, no extra borders or backgrounds, and it closes the way the browser's does).

**Why:** The user asked whether Playwright could open the native extension popover "so we don't have to do custom things to make it work", and asked for the custom popover to show only one layer, the extension page.

**How to apply:** Before building UI or logic that imitates a browser feature in the drawer, check for a native route (CDP, BiDi, Playwright API); explain plainly when none exists, then match native look and behavior. Related: [[keep-changes-local]]
