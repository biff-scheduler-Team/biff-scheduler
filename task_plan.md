# React Router + React Spectrum rewrite

## Objective
Rebuild the entire UI in an isolated worktree with React Router and React Spectrum. Preserve every existing localStorage contract and original features. Complete browser E2E tests.

## Phases
1. Audit features, persistence, data, and tests — complete
2. Implement React app, router, Spectrum components and storage integration — complete
3. Complete feature parity and responsive UI — complete
4. E2E legacy compatibility and feature tests; fix regressions — complete
5. Build, lint, unit tests, browser inspection, documentation — complete

## Constraints
- Worktree: /Users/citr/Developer/GitHub/biff-scheduler-react-spectrum
- Branch: codex/react-router-spectrum
- Preserve original checkout and existing data keys/formats.
- Keep proven domain functions; replace imperative DOM UI completely.
- Do not deploy or change actual user browser storage.

## Final verification
- `npm run test:e2e`: 69/69 Playwright tests passed across desktop Chromium, mobile Chromium, and mobile WebKit, with desktop-only PWA/drag/zoom tests.
- `npm run build`: typecheck, lint, 173/173 unit tests, Vite and PWA generation passed.
- Desktop, mobile timeline, and nested film dialog visually inspected.
- Original main checkout remains clean. Changes are isolated in the requested worktree.

## Follow-up: feature parity audit
- Request: use subagents to compare rewrite with original and identify missing behavior.
- Library/details audit: complete.
- Schedule/interactions audit: complete.
- Agenda/storage/export audit: complete.
- Root verification and consolidated report: complete.
- Scope: read-only source and browser comparison; no implementation fixes.

Audit outcome: 34 confirmed feature omissions or behavior regressions. Prior implementation-phase completion means the rewrite and its original test suite were delivered, not that parity is established. Findings remain unfixed; see docs/parity-audit-20260912.md.

## Follow-up: restore legacy behavior
User directive: all logic follows the actual 8a95215 implementation; UX/UI may change. Complete the missing features.
- Library/details fixes and regression tests: complete (library agent).
- Schedule/navigation/gestures fixes and tests: complete (schedule agent).
- Agenda/rank/ticketing fixes and tests: complete (agenda agent).
- Settings/GV/shared cards/export image lifecycle/test isolation: complete (root).
- Integrated production E2E and behavior verification: complete.
- Update all 34 audit findings with fix evidence: complete.

Additional source discrepancies discovered while fixing are included: old library is read-only for screening selection; no-schedule catalog entries cannot be added; export defaults to newest saved plan; ticket alarm is fixed at 30 minutes.

Final restoration verification: npm run test:e2e passed. 19 suites/188 unit tests; 148 E2E executions (57 scenarios), 0 failures, 0 skips, 52.7 seconds. New dev31027 retained. Main checkout untouched. See docs/parity-restoration.md.

## Follow-up: independent post-restoration review
- User requested another fresh subagent review.
- Three independent reviewers: library/details; schedule/interactions; state/agenda/export.
- Scope: read-only source and isolated browser checks; no implementation edits.
- Findings verification and report: complete.

Post-restoration review result:8 confirmed P2,2 P3 behavior/text differences,1 nonblocking P3 UX observation. Implementation unchanged during this review; see docs/post-restoration-review.md.

## Follow-up: repair review findings and add /legacy
- User authorized subagents to repair all latest review findings: complete.
- Library/detail source identity and return scroll: library agent.
- Schedule date/zoom/breakpoint correctness: schedule agent.
- Rank load order, image fallback, ticket clock: state/export agent.
- Shared hour selection/card linkage and non-GV gap text: root.
- New user request: retain actual original app at /legacy/ with a visible version switch, shared origin/storage: complete (root).
- Full production verification including new/legacy interchange: complete.

Final review-fix/legacy result:200 unit tests and209 E2E executions passed,0 failures/0 skips; typecheck/lint/dual-entry build passed. /legacy redirects to /legacy/, both versions share biff.* storage and offline precache. No main checkout edits or deployment.

## Follow-up: vertical time axis and page scrolling
- User requested time on Y axis, venues on X; schedule must have no internal vertical scrolling.
- Use one vertical resource grid at all widths; horizontal overflow stays in the grid, vertical scrolling belongs to the page.
- Keep legacy entry unchanged and preserve picks, GV, conflicts, filters, routes, exports and storage.
- Vertical geometry, page-scroll zoom anchors, sticky horizontal-synced headers: complete.
- Renderer, horizontal pan, locate and GV duration controls: complete.
- Orientation-specific tests, wheel/page-scroll assertions and desktop/mobile visual QA: complete. Typecheck, lint, 203 unit tests and 215 E2E executions passed on 2026-09-13.
