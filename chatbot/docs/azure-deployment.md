# Deploying on Azure OpenAI Service

Step-by-step walkthrough for moving from OpenAI direct (local development)
to Azure OpenAI Service (production deployment). The codebase needs **zero
changes** — only `.env` configuration.

---

## Prerequisites

1. **Azure subscription**
   - Free tier works for development: [azure.microsoft.com/free](https://azure.microsoft.com/free)
   - Production: pay-as-you-go subscription on a Microsoft Customer Agreement

2. **Azure OpenAI Service access**
   - Apply at [aka.ms/oai/access](https://aka.ms/oai/access)
   - Approval typically 1–7 working days for enterprise applications
   - Individual / portfolio applications may take longer or be redirected
     to a partner program

3. **Resource quota**
   - Each Azure OpenAI resource has TPM (tokens per minute) and RPM (requests
     per minute) quotas, set per deployment
   - For this chatbot's expected load (≤10 concurrent users), the default
     1k TPM / 60 RPM is sufficient

---

## Step 1 — Create the Azure OpenAI resource

Via Azure Portal:

1. Open [Azure Portal](https://portal.azure.com) → search for *Azure OpenAI*
2. Click **Create** → fill in:
   - **Subscription**: your active subscription
   - **Resource group**: create new `rg-ulovdomov-chatbot` or use existing
   - **Region**: choose an EU region for GDPR data residency (recommended:
     **West Europe** or **Sweden Central**)
   - **Name**: e.g. `oai-ulovdomov-chatbot`
   - **Pricing tier**: Standard S0 for production, F0 (free tier) for testing
3. **Network**: allow public access initially; switch to private endpoint
   once production traffic stabilises
4. **Identity**: enable system-assigned managed identity (used later for
   keyless authentication)
5. Click **Review + Create** → wait ~2 minutes for deployment

---

## Step 2 — Deploy the chat model

In the new resource:

1. Open **Azure AI Foundry** (button in the overview pane)
2. **Deployments** → **Create new deployment**
3. Select model: **gpt-4o-mini** (recommended for cost/quality balance)
4. Deployment type: **Standard** (regional, lowest latency for EU users)
5. Deployment name: e.g. `gpt-4o-mini-ulovdomov` — this is what you put
   into `AZURE_OPENAI_CHAT_DEPLOYMENT`
6. Tokens per minute: leave default (or raise per quota)
7. Click **Deploy** → ready in ~30 seconds

Repeat for the embedding model:

1. **Create new deployment**
2. Model: **text-embedding-3-small**
3. Deployment name: `text-embedding-3-small-ulovdomov`
4. Deploy

---

## Step 3 — Get keys and endpoint

In the Azure OpenAI resource overview:

- **Endpoint**: `https://oai-ulovdomov-chatbot.openai.azure.com/`
- **Keys and Endpoint** blade → **KEY 1** (keep secret)
- **API version**: latest stable, currently `2024-10-21`
- **Deployment names**: from Step 2

---

## Step 4 — Wire into `.env`

Edit `chatbot/.env`:

```bash
# Comment out or remove OPENAI_API_KEY — the client auto-detects Azure first
# OPENAI_API_KEY=sk-proj-...

AZURE_OPENAI_ENDPOINT=https://oai-ulovdomov-chatbot.openai.azure.com
AZURE_OPENAI_API_KEY=<key from Azure portal>
AZURE_OPENAI_API_VERSION=2024-10-21
AZURE_OPENAI_CHAT_DEPLOYMENT=gpt-4o-mini-ulovdomov
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=text-embedding-3-small-ulovdomov
```

That's it. Restart the CLI / app:

```bash
npm run chat
# → header now reports "LLM backend: Azure OpenAI"
```

The same code path runs against Azure — no edits to agents, RAG, or
orchestrator. This is by design (see [`architecture.md`](architecture.md)
§"Why endpoint-agnostic LLM client").

---

## Step 5 — Production hardening (recommended)

### Switch from API key to managed identity

Hard-coded API keys in `.env` are fine for local dev. For production:

1. In the Azure OpenAI resource, enable **system-assigned managed identity**
2. Grant the chatbot's hosting service (App Service / Container App) the
   **Cognitive Services OpenAI User** role on the OpenAI resource
3. Update the client to use `DefaultAzureCredential` instead of the API key

The `openai` SDK supports this — set `azure_ad_token_provider` instead of
`api_key`. v0.2 of this chatbot adds the switch behind a flag.

### Content filter policies

Azure OpenAI ships with default content filters (hate, sexual, violence,
self-harm). For úlovdomov.cz the defaults are sufficient. If a customer
ever asks something filter-triggering, the SDK throws a content filter
error that the orchestrator should catch and route to escalation.

### Private endpoint + virtual network

Once production traffic stabilises:

1. Create a **virtual network** in the same region
2. Add a **private endpoint** to the Azure OpenAI resource
3. Disable public network access on the resource
4. Host the chatbot's API service in the same VNET

Traffic stays on Microsoft's backbone — no public internet hop.

### Quota monitoring

Set up **Azure Monitor alerts** on:
- TPM utilization > 80% (raise quota before users see 429s)
- Request error rate > 1% (early warning of throttling or content filter)
- Cost > daily budget (avoid surprises)

---

## Cost estimate

For úlovdomov.cz expected traffic patterns (rough order of magnitude):

| Item | Estimate |
|---|---|
| Avg conversation length | 4 turns |
| Avg tokens per turn (in/out) | 1900 / 180 |
| Conversations per day | 500 (low) → 5,000 (high) |
| Monthly tokens (low) | ~125 M / month |
| **Monthly cost** (gpt-4o-mini, Azure Standard) | **~€100** low — **~€1,000** high |

Plus minimal embedding cost (~€5/month even at high volume — embeddings
are very cheap on `text-embedding-3-small`).

The Standard tier on Azure has the same per-token price as OpenAI direct
in EU regions. The pricing premium for Azure is operational, not per-token.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `404 Resource not found` on chat call | `AZURE_OPENAI_CHAT_DEPLOYMENT` is wrong (it's the **deployment name** from Step 2, not the model name) |
| `401 Unauthorized` | API key mismatch or rotated. Re-copy from portal. |
| `429 TooManyRequests` | Hit TPM/RPM quota. Raise in Azure Foundry → Deployments → your deployment → quota |
| `Content filter triggered` | A safety category fired. Inspect the error details; consider adjusting filter policy if too strict |
| Embedding endpoint timeouts | Cross-region call. Make sure embedding deployment is in the same region as chat |

---

## Related

- [Microsoft Learn — Azure OpenAI Service](https://learn.microsoft.com/azure/ai-services/openai/)
- [Azure OpenAI access application form](https://aka.ms/oai/access)
- [OpenAI SDK — Azure quickstart](https://github.com/openai/openai-node#azure)
- [Architecture deep-dive](architecture.md)
