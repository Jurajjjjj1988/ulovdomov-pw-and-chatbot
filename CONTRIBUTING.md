# Contributing

Thanks for the interest! This is a personal portfolio repo so external
contributions are limited, but if you found a bug or have a sharp idea,
issue / PR are welcome.

---

## Repo layout

This repository contains **two independent modules** that share only the
domain (úlovdomov.cz):

- **`./` (Playwright tests)** — Module 1. Runs E2E tests against the
  live site.
- **`chatbot/`** — Module 2. Multi-agent LLM customer support chatbot.

Each module has its **own** `package.json`, `tsconfig.json`, ESLint config,
and CI workflow. They share **nothing at the JS level** — installing
dependencies and running scripts is per-module.

---

## Setup

### Playwright module (root)

```bash
npm install
npx playwright install chromium
cp .env.example .env  # fill BASE_URL, TEST_USER_*, SLACK_WEBHOOK_URL
npx playwright test --project=chromium
```

### Chatbot module

```bash
cd chatbot
npm install
cp .env.example .env  # fill OPENAI_API_KEY (or AZURE_OPENAI_*)
npm run ingest:kb     # build the RAG index
npm run chat          # interactive CLI
```

---

## Workflow

1. **Open an issue first** — describe the bug / proposal. Saves both sides
   time before code is written.
2. **Branch from `main`** — name as `fix/<short>` or `feat/<short>`.
3. **Make the change**.
   - For chatbot: if you change a prompt, document the diff in
     `chatbot/docs/prompts-iteration-log.md` (the *why*, not just the *what*).
   - For tests: keep specs idempotent; no spec should depend on the
     order of another.
4. **Pass CI locally** before pushing:
   - Playwright module: `npm run typecheck && npm run lint && npx playwright test`
   - Chatbot module: `cd chatbot && npx tsc --noEmit && npm test`
5. **Open a PR against `main`** with a description following the format:
   ```
   ## What changed
   <bullet list>

   ## Why
   <reasoning>

   ## How was it tested
   <commands run / manual verification steps>
   ```

---

## Code style

### TypeScript

- **Strict mode** everywhere. No `any`, no `as unknown as`, no
  `// @ts-ignore`.
- **ESM imports** with explicit `.js` suffix (TypeScript Node ESM convention).
- **Prefer named exports** over default exports for greenfield modules.

### Commit messages

Loose convention: `<type>(<scope>): <subject>`

Examples:
- `feat(chatbot): add property search agent + listings tool`
- `fix(tests): handle empty search results without throwing`
- `docs(chatbot): clarify Azure OpenAI quota notes`
- `ci(chatbot): add typecheck workflow`
- `refactor(tests): consolidate cookie banner dismissal in BasePage`

Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `ci`, `test`.
Scopes: `tests`, `chatbot`, `ci`, or omitted for cross-cutting changes.

### Prompts (chatbot module)

System prompts live as `.md` files under `chatbot/src/prompts/`. When you
change one:

1. **Edit the markdown** (don't inline the prompt in the agent code).
2. **Update `chatbot/docs/prompts-iteration-log.md`** with the version
   bump, what changed, and why.
3. **Re-evaluate** on the labeled set in `chatbot/src/agents/*.test.ts`.
   If accuracy regresses, revert and try a different angle.

---

## What lives where

| Concern | Place |
|---|---|
| Page Object Models | `pages/` (Module 1) |
| Test specs | `tests/` (Module 1) |
| System prompts | `chatbot/src/prompts/*.system.md` |
| Agent implementations | `chatbot/src/agents/` |
| Tool schemas + impl | `chatbot/src/tools/` |
| RAG retriever | `chatbot/src/rag/` |
| Knowledge base (Czech/Slovak) | `chatbot/knowledge-base/*.md` |
| Conversation logging | `chatbot/src/conversation-log.ts` |
| Evaluation scripts | `chatbot/src/eval/` |
| Architecture docs | `chatbot/docs/architecture.md` |

---

## Not affiliated

This repository is a portfolio project and is **not affiliated with
úlovdomov.cz**. All trademarks belong to their respective owners. Test
selectors, test data, and chatbot knowledge base reflect publicly
available information from the live site for educational and
demonstration purposes.

If you represent úlovdomov.cz and want this repo taken down or modified,
open an issue or contact me directly via the email in [`LICENSE`](LICENSE).
