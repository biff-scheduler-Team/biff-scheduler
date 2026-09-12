# Progress

- Created isolated worktree codex/react-router-spectrum from main 8a95215.
- Loaded planning, component, design, forms, accessibility, and writing guidance.
- Began feature and persistence audit; consulted official React Router and Spectrum documentation.
- Completed storage inventory and source-based parity audit (README contains stale feature descriptions).
- Extracted tested grid/timeline/filter/legend models; removed imperative DOM views.
- Chose React 19 + React Router 8.3.1 + React Spectrum S2; installing dependencies.
- Implemented React Spectrum S2 controls, React Router routes, dual-pane desktop layout, and mobile timeline.
- Added legacy-compatible notes, ranks, GV overrides, saved plans, calendar/text/image export, backup/ICS import, settings, ticketing, and guide dialogs.
- First verification found extraction-only missing symbol imports and TypeScript target mismatch; fixed imports and moved target to ES2022.
- Added Playwright production-preview setup for desktop Chromium, mobile Chromium, and mobile WebKit.

- Desktop E2E exposed Spectrum-specific issues: nested DialogContainer context leaked into GV dialogs; dismissible dialogs hide their footer by design; hidden checkbox input must be exercised via its visible label.
- Fixed detail modal isolation and footer, accessible note labels, default export-plan selection, and explicit input locators.
- Long backup textarea autosize moved the button between pointerdown/up; bounded the editor height to remove the scroll anchoring jump.
- Unit suite: 173/173 passed. Production typecheck/lint passed. Re-running full 3-browser E2E suite after fixes.

- Final production E2E: 69/69 passed in 41.1 seconds. Includes 3 viewport/engine configurations, original-implementation round trips, downloads, imports, nested dialogs, ranks, drag, hover, zoom anchor, and offline PWA.
- Production bundles split into app (90 KB), React/Router (319 KB), Spectrum (379 KB); all chunks below the 500 KB warning threshold.
- Desktop and mobile screenshots inspected. Timeline and details have no horizontal overflow; Gantt scrolling stays inside the desktop viewport.
- README and migration documentation updated. Removed obsolete DOM helpers. Original main checkout remains untouched.

- Started user-requested independent feature parity audit with three subagents. Old baseline remains 8a95215. Temporary original dev on port 31028; rewrite dev on 31027 retained.

- Three independent audits completed. Consolidated 34 confirmed omissions/regressions with old/new source anchors, reproduction evidence, and test gaps into docs/parity-audit-20260912.md. No implementation fixes made in this audit.

- User authorized completing functionality with all logic anchored to 8a95215. Reused three audit agents with non-overlapping file ownership; root handles shared controls, dialogs, exports, and final verification.

- Implemented all 34 audited restorations with dedicated module ownership and regression suites. Additional old rules restored: library/info read-only; newest export plan; ticket alarm30; global empty numbers0; GV draft confirmation.
- Cross-review caught and fixed React portal bubbling into whole-card selection; a new E2E checks that clicking the GV dialog title preserves picks.
- Production testing is now isolated at31029 with no existing-server reuse. Initial integration found stale-bundle/test-expectation issues; corrected pointer drag targets, refreshed builds, and scoped desktop/mobile-only scenarios explicitly.
- Added docs/parity-restoration.md mapping every original finding to implementation and test coverage. Final full production test run in progress.

- Final integrated production run passed: TypeScript, ESLint,19 unit suites/188 tests;148 E2E executions across desktop Chromium, mobile Chromium and mobile WebKit,0 failures and0 skips (52.7 seconds).
- Final suite includes canceled settings/GV drafts, newest export selection, PNG re-open/content races/fallback, portal isolation, empty global fields, all34 audit regressions, and continued legacy storage round trips.
- Desktop Gantt tests and mobile timeline tests are selected per-project instead of counted as skipped. Mobile Chromium uses native CDP touch; WebKit exercises browser touch PointerEvents.
- After the passing production run, visual QA found a black wordmark on the dark header; corrected its dark-theme CSS filter. No business logic changed. Updated completion mapping and retained31027 dev for user preview.

- Started a fresh three-agent read-only review after restoration. Main agent coordinates independent reproduction and supplements with CodeRabbit; existing dev31027 retained.

- Fresh review completed:8 P2 findings,1 P3 behavior difference,1 nonblocking UX observation. All reported runtime paths verified in isolated browser contexts with old-source comparisons. No implementation changes; report at docs/post-restoration-review.md.

- Verified a supplemental CodeRabbit finding in an isolated browser: with global GV off, a non-GV preceding screening is incorrectly labeled as having skipped its talk. Classified P3; no implementation changes.

- Latest review fixes implemented by three independent agents; root integrated shared stable date/hour state, agenda hour highlighting, exact screening detail navigation and non-GV gap labeling.
- User added /legacy fallback request. Added a genuine separate HTML entry containing frozen8a95215 TypeScript sources, isolated Tailwind CSS, root-relative data via base URL, new/old full-document links, development/preview/deployment bare-path redirect, and PWA precache aliases.
- Targeted production checks passed7/7: legacy entry, identical storage across switches, legacy selection read by rewrite, root data URLs, new/legacy offline switching, hour linkage, and non-GV gap text.
- Added a SHA256 manifest test for frozen legacy TypeScript sources. Full multi-entry production E2E in progress.

- Final production verification:23 suites/200 unit tests, TypeScript/ESLint, dual HTML entry Vite+PWA build,209 Playwright executions across desktop Chromium/mobile Chromium/mobile WebKit all passed (0 failed/0 skipped,1.2min).
- Visual QA of /legacy desktop/mobile passed; no mobile overflow. New/old navigation is full-document and shares storage; root static-data URLs and offline /legacy aliases verified.
- All8 P2 and3 lower-priority findings from the latest review are resolved. Added review-fixes-and-legacy.md with implementation/test mapping. Dev31027 remains active; original main is untouched.

## 2026-09-13: Vertical time axis

- Replaced the horizontal desktop schedule and phone list with one vertical time/venue grid. The document owns vertical scrolling; the grid only scrolls horizontally.
- Added sticky synchronized venue headers, vertical film/GV segments, same-venue overlap lanes and page-time zoom anchors. Reused the GV duration dialog.
- Fixed feedback between programmatic header synchronization and pointer panning.
- Preserved storage/domain logic and the frozen legacy entry.
- Validation: typecheck, lint, 24 suites / 203 unit tests; 215 Playwright executions passed, zero failures/skips (1.4m). Desktop and iPhone WebKit screenshots checked. Mobile WebKit uses document-scroll geometry because Playwright does not inject native swipe/wheel there.

## 2026-09-13: Floating viewing panel

- Replaced the picks/agenda sidebar with a bottom-right floating panel and launcher. Tabs share the panel; library is a standalone page.
- Selecting no longer opens the panel. Locating closes it and reveals the schedule target. Mobile gets a viewport-bounded bottom panel.
- Preserved legacy storage keys, including existing panel-width preference; legacy entry unchanged.
- Verified desktop/mobile geometry and focus. Fixed header obstruction for long panels and avoided overriding an expanded film's focus.
- Validation: typecheck, lint and 203 unit tests passed. Full E2E run passed 214/218; corrected the obsolete location test and stabilized focus before the detail reading-position assertion. All 30 edge-case/library tests then passed, covering all four previous failures. All 218 scenarios now pass across the full run and targeted rerun.
