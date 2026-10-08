# Tournament verification

Verified locally on 8 October 2026 using disposable databases. The live database was not changed.

## Results

| Check                                                     | Result          |
| --------------------------------------------------------- | --------------- |
| Native PostgreSQL integration suite                       | 80 tests passed |
| Existing browser suite, including futsal qualification UI | 27 tests passed |
| Full registration-to-final tournament scenario            | 1 test passed   |
| TypeScript checks and production build                    | Passed          |

The full tournament scenario uses production registration, payment verification, profile, group assignment, scoring, qualification, draw, bracket, and report routes. Browser interactions verify registration closure, group assignment, scoring and player credits, public live scoreboards, the third-place draw form, and public qualification displays. Other matches and bulk registrations use the same production APIs.

## Registration and groups

| Sport      | Capacity tested | Completed player profiles | Groups        | Group matches | Knockout matches |
| ---------- | --------------: | ------------------------: | ------------- | ------------: | ---------------: |
| Futsal     |        24 teams |                       120 | 6 groups of 4 |            36 |               15 |
| Cricksal   |        16 teams |                       112 | 4 groups of 4 |            24 |                7 |
| Basketball |        16 teams |                        48 | 4 groups of 4 |            24 |                7 |
| Total      |        56 teams |                       280 |               |            84 |               29 |

Each registration submits an invoice, payment request, receipt, organizer payment verification, company logo, roster, jersey sizes, and player photos. Incomplete profiles cannot be finalized. At capacity, another invoice returns `409 sport_full`, the sport is disabled in registration, and sports with available places remain selectable. Limits are configured through the production admin API in the isolated test.

All teams are assigned through the organizer UI. Each group contains four distinct teams and six fixtures. Brackets remain empty before qualification is resolved, and reassignment is blocked after fixtures exist.

## Qualification and match checks

- Second and third tied on points: head-to-head takes precedence over goal difference.
- Drawn head-to-head: goal difference, then goals scored, then the existing alphabetical fallback resolve group positions.
- Three teams tied on points: existing group rules skip head-to-head and use goal difference, then goals scored.
- Third-place ranking uses points, goal difference, and goals scored. Automatic qualification and bracket creation are checked when these resolve the cutoff.
- Exact third-place ties across the fourth qualifying position require a manual draw. Scenarios cover two teams at the cutoff, three teams for the final place, five teams for four places, and all six teams tied.
- Ties entirely above or below the cutoff do not require a draw. Duplicate, invalid, unauthorized, and stale draw submissions are rejected; successful draws are audited.
- All 15 possible combinations of four qualifying third-place groups produce a valid round of 16 with no same-group opponents.
- Browser scoring verifies saved player credits on public live scoreboards. Cricket also verifies batting selection, batting swaps, overs, wickets, bowler credits, and super-over selection.
- Tied knockout matches cannot finish without a winner. Winners advance through every round; all three finals finish and knockout reports include all expected matches.

## Repeat locally

```sh
npm run test:postgres
npm run test:browser
npm run test:tournament
npm run typecheck
npm run build
```

The full tournament scenario is in `tests/tournament.e2e.ts`; additional tie scenarios are in `tests/futsal-qualification.test.ts`. Its JSON report and screenshots are written under `playwright-report/` and are ignored by Git. Failures retain a Playwright trace.

Google authentication and storage/email providers use test doubles; external provider delivery and production infrastructure are outside this local verification. The existing browser suite exercises the application OAuth routes with a mocked Google provider. The bulk tournament scenario creates isolated captain sessions before using registration routes.
