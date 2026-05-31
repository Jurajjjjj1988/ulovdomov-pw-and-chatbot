# Deploy — Azure infrastructure as code

Bicep template that provisions the production infrastructure for the
úlovdomov chatbot on Azure. Pair with the conceptual walkthrough in
[`../docs/azure-deployment.md`](../docs/azure-deployment.md) and the
design rationale in [`../docs/chatbot-deep-dive.md`](../docs/chatbot-deep-dive.md)
§ "Deploying on Azure."

## What it provisions

| Resource | Purpose |
|---|---|
| Log Analytics workspace | Backing store for Application Insights and Container Apps logs |
| Application Insights | OTel GenAI span / metrics ingestion |
| Azure Container Registry (Basic) | Image storage |
| Azure Key Vault | `openai-key` + `chatbot-api-key` secrets, RBAC-authorized |
| Azure OpenAI Service (S0) | `gpt-4o-mini` + `text-embedding-3-small` deployments |
| Container Apps Environment | Managed env (log analytics integrated) |
| Container App (chatbot) | Public ingress on port 3000, scale 0–3 replicas |
| RBAC: Container App MI → Key Vault Secrets User | Lets the app pull secrets without storing them in app config |

## Prerequisites

1. **Pay-As-You-Go subscription** — Azure Free tier explicitly cannot
   deploy Azure OpenAI or Marketplace partner models. See the deep-dive
   doc § "Quota and approval."
2. **Azure OpenAI access approved** — `aka.ms/oai/access` form, 1–7
   working days.
3. **Resource group** — created beforehand
   (`az group create -n rg-ulovdomov-chatbot -l westeurope`).
4. **Container image** — built locally and pushed to a registry
   (`az acr build` or `docker push`). Reference it in
   `containerImage` parameter.

## Deploy

```bash
# 1. Build + push the container image
az acr login --name ulovdomovchatbot
docker build -t ulovdomovchatbot.azurecr.io/chatbot:0.2.0 ../
docker push ulovdomovchatbot.azurecr.io/chatbot:0.2.0

# 2. Run the bicep deployment
az deployment group create \
  --resource-group rg-ulovdomov-chatbot \
  --template-file main.bicep \
  --parameters \
      environmentName=ulovdomov-chatbot \
      containerImage=ulovdomovchatbot.azurecr.io/chatbot:0.2.0

# 3. Populate the Key Vault secrets (one-time)
KV=$(az deployment group show -g rg-ulovdomov-chatbot \
        -n main --query properties.outputs.keyVaultUri.value -o tsv)
az keyvault secret set --vault-name "${KV%/}" --name openai-key \
                       --value "<your AZURE_OPENAI_API_KEY>"
az keyvault secret set --vault-name "${KV%/}" --name chatbot-api-key \
                       --value "$(openssl rand -hex 32)"
```

## Verify

```bash
FQDN=$(az containerapp show -n ulovdomov-chatbot \
         -g rg-ulovdomov-chatbot --query properties.configuration.ingress.fqdn -o tsv)

curl https://$FQDN/health
curl https://$FQDN/docs/json | jq .info
```

## What this template doesn't do (production hardening)

- Private endpoints / VNet integration (lift to a separate network module
  when traffic warrants).
- WAF + custom domain at Azure Front Door (separate `frontdoor.bicep`).
- Per-deployment quota tuning beyond the default `capacity: 30`.
- Per-environment param files (dev / staging / prod) — currently one
  flat template; split via Bicep modules.
- Cost guardrails (Budget + Action Group) — add in a `budget.bicep` module.

These are intentionally separated so the core stays readable. Add as
your platform discipline matures.
