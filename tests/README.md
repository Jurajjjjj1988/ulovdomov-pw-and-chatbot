# Module 1 — Playwright E2E test suite

Playwright test automation for [ulovdomov.cz](https://www.ulovdomov.cz),
the Czech real estate platform.

This is **Module 1** of the [ulovdomov-pw-and-chatbot](../README.md) suite.
The companion [Module 2](../chatbot/README.md) is a multi-agent AI customer
support chatbot for the same platform.

> ⚠️ **Portfolio DEMO project.** Not affiliated with úlovdomov.cz.

---

## What's covered

| Test       | Type       | What it verifies                                             |
| ---------- | ---------- | ------------------------------------------------------------ |
| Homepage   | Smoke      | Hero section, search form, listing sections, navigation      |
| Search     | Functional | Autocomplete location input, results match searched location |
| Sort       | Functional | Price order after sorting by cheapest                        |
| Navigation | Navigation | Post ad link, logo back to homepage                          |
| Map        | Layout     | Map visible on desktop, hidden on mobile                     |
| Responsive | Layout     | Mobile layout — search form, edit button, map hidden         |
| Login      | Auth       | Login via modal with email/password                          |
| Profile    | CRUD       | Edit personal data, save, reload and verify persistence      |
| Detail     | Navigation | Click listing card, verify detail page loads (skip on 500)   |
| E2E Flow   | E2E        | Homepage → search → sort → detail (full user journey)        |

---

## Setup

```bash
# From the repo root
npm install
npx playwright install chromium
```

Create `.env` in the project root:

```
BASE_URL=https://www.ulovdomov.cz
TEST_USER_EMAIL=your@email.com
TEST_USER_PASSWORD=yourpassword
```

> The chatbot module (`../chatbot/`) has its **own** `package.json` and `.env`
> — the two modules don't share dependencies.

---

## Run tests

```bash
# All tests
npx playwright test --project=chromium

# Single test file
npx playwright test tests/search.spec.ts --project=chromium

# With UI mode
npx playwright test --project=chromium --ui
```

---

## CI/CD

Tests run automatically via GitHub Actions:

- **On push** to `main` — runs tests, notifies Slack on failure and success
- **On pull request** — runs tests, blocks merge if tests fail
- **Scheduled** — Mon–Fri at 8:00 UTC, notifies Slack on failure
- **Manual** — trigger via `workflow_dispatch` in Actions tab

### Reports

- **Latest report**: [GitHub Pages](https://jurajjjjj1988.github.io/playwright/report/)
  (deployed after each main branch run)
- **Artifacts**: HTML report + JSON results stored for 14 days per run
- **Slack**: failure/success messages with test counts, duration, and link to report

### Required secrets

| Secret               | Description                              |
| -------------------- | ---------------------------------------- |
| `BASE_URL`           | Target site URL                          |
| `TEST_USER_EMAIL`    | Test account email                       |
| `TEST_USER_PASSWORD` | Test account password                    |
| `SLACK_WEBHOOK_URL`  | Slack incoming webhook for notifications |

---

## Project structure (this module)

```
playwright-tests/
├── tests/                   # Test specs
│   └── README.md            # ← you are here
├── pages/                   # Page Object Models
│   ├── base.page.ts         # Shared: navigation, overlay dismiss, URL checks
│   ├── home.page.ts         # Homepage: search form, listings
│   ├── search-results.page.ts
│   ├── login.page.ts        # Login modal
│   └── profile.page.ts      # Profile edit form
├── fixtures/                # Playwright fixtures for POM injection
├── helpers/                 # Reusable utilities (price parsing, etc.)
├── data/                    # Test constants and credentials reference
├── docs/                    # Architecture / theory guide
├── .github/workflows/       # CI pipeline
├── playwright.config.ts
├── Dockerfile               # Slim chromium image for CI
├── job.yaml                 # Kubernetes Job manifest
└── .env                     # Environment variables (not committed)
```

---

## Notes

- Cookie consent is automatically dismissed via `BasePage.dismissOverlay()`
- Login uses a modal, not a separate page — selectors use `data-test` attributes
- Listing detail tests may be skipped if the server returns 500 (external site instability)
- Tests run with 2 workers locally, 1 worker in CI to avoid rate limiting
- CI reporter outputs HTML (for Pages), JSON (for Slack stats), and GitHub annotations

---

## What's planned for v0.2 (this week)

- Tests that **drive the AI chatbot UI** (Module 2) end-to-end:
  - Intent classification accuracy from end-user perspective
  - Escalation flow correctness (does the bot actually create a ticket?)
  - RAG grounding verification (does the bot cite correct sources?)
- API-level contract tests (Zod schemas)
- k6 load tests of the search endpoint

This will round out the **AI Quality Engineering** story — production
testing + AI engineering + automated testing of the AI itself.

---

## Related

- [Module 2 — AI chatbot](../chatbot/README.md)
- [Suite root README](../README.md)
