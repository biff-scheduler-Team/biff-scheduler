# Findings

- Original is Vite + TypeScript, no React. Clean main at 8a95215.
- 17 unit test files; static schedule, venues, films, Douban, related, intros and festival extras; offline PWA.
- Picks stored only locally. Historical group and priority fields are ignored by current app.
- Need audit all persistence before implementation.

## Persistence contract
- biff.picks.v2: array of {key, picks:[{code}], note}; keys cat:<film id> or sched:<lowercase English title>.
- biff.plan.v1 / biff.wish.v1: one-time migration follows original state.ts (only plan slots/notes, ignore retired priorities).
- biff.settings.v1: alarmMin, transitMin, gvTalkOn, gvTalkMin, theme, zoom; preserve unknown settings on writes.
- biff.gvtalk.v1 boolean map; biff.gvtalkmin.v1 number map; biff.ranks.v1 rank map.
- biff.agendafold.v1 dates array; biff.savedplans.v1 array of {id,name,codes,createdAt}.
- biff.filters.v1 and biff.libfilters.v1: independent {subs:[],venues:[],venueMode,gv}.
- biff.pickerw.v1: numeric string, clamp 520..800; absent = adaptive width.
- Backup v1 snapshots every biff.* value as its raw string, including unknown keys.
- Routing requires root-relative data/assets. Original relative fetch URLs break nested direct loads.
- Original state removes a last slot with empty note; preserve actual behavior over outdated README claims.
- Retain pure domain modules and tests. Remove old imperative UI and Tailwind styling.


## Parity audit: independent root verification
- Settings cancel regression reproduced in both versions: edit alarm 45→90, cancel/close, reopen. Original shows45 and stored45; rewrite shows90 while stored45. `SettingsDialog` retains useState draft between openings.
- Stale settings overwrite reproduced: initially saved light/0.7, change toolbar to dark/0.9, open Settings and save without editing. Original stays dark/0.9; rewrite reverts storage to light/0.7.
- E2E has25 distinct test definitions expanded to69 project executions. None of the existing settings tests covers canceled/reopened drafts or toolbar→settings stale snapshot writes.
- Playwright preview and dev share31027 with reuseExistingServer enabled; current endpoint contains /@vite/client. A future test:e2e run can therefore reuse dev instead of the just-built production bundle. Earlier69-pass result was run against preview; this is a reproducibility gap.
