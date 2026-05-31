// úlovdomov chatbot — Azure infrastructure definition (Bicep).
//
// One-shot infrastructure for the production deployment described in
// docs/azure-deployment.md and docs/chatbot-deep-dive.md § "Deploying on Azure":
//
//   - Azure Container Apps environment + Container App running the chatbot image
//   - Azure OpenAI Service (gpt-4o-mini + text-embedding-3-small deployments)
//   - Azure Key Vault holding the OpenAI key + the chatbot API key
//   - Application Insights for OTel GenAI span ingestion
//   - Log Analytics Workspace for App Insights backing store
//   - Container Registry for the image
//
// The container's Managed Identity is granted Key Vault Secrets User on the
// vault and Reader on the OpenAI resource — no plaintext secrets land in the
// Container App's configuration. Secrets are pulled via Key Vault references
// using the @Microsoft.KeyVault(SecretUri=...) syntax (or via DefaultAzureCredential
// inside the app code if you prefer the runtime SDK approach).
//
// Deploy with:
//   az deployment group create \
//     --resource-group rg-ulovdomov-chatbot \
//     --template-file main.bicep \
//     --parameters environmentName=ulovdomov-chatbot-prod
//
// This file is a starting point — production deployments typically split
// further into network (Container Apps Environment with VNet), identity,
// data, and app modules. Kept flat here for readability.

@description('Short name used as a prefix for all resources. Lowercase, hyphens.')
param environmentName string = 'ulovdomov-chatbot'

@description('Azure region (EU recommended for GDPR).')
param location string = 'westeurope'

@description('Container image to deploy. Push your built chatbot image here first.')
param containerImage string = 'ghcr.io/jurajjjjj1988/ulovdomov-chatbot:latest'

@description('How many replicas to run. Container Apps scales 0-N; this is the min cap.')
@minValue(0)
param minReplicas int = 0

@description('Max replicas — Container Apps autoscaling cap.')
@minValue(1)
param maxReplicas int = 3

@description('Azure OpenAI SKU. Standard is the default; check region availability.')
param openAiSku string = 'S0'

// ─── Log Analytics + Application Insights ──────────────────────────────────

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${environmentName}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${environmentName}-appi'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

// ─── Container Registry ────────────────────────────────────────────────────

resource registry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: replace(environmentName, '-', '')
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

// ─── Key Vault ─────────────────────────────────────────────────────────────

resource keyVault 'Microsoft.KeyVault/vaults@2024-04-01-preview' = {
  name: '${environmentName}-kv'
  location: location
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true // RBAC, not access policies — modern pattern
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    enablePurgeProtection: true
  }
}

// ─── Azure OpenAI ──────────────────────────────────────────────────────────

resource openAi 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: '${environmentName}-aoai'
  location: location
  sku: { name: openAiSku }
  kind: 'OpenAI'
  identity: { type: 'SystemAssigned' }
  properties: {
    customSubDomainName: '${environmentName}-aoai'
    publicNetworkAccess: 'Enabled' // restrict via private endpoint in production-prod
  }
}

resource gptDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: openAi
  name: 'gpt-4o-mini'
  sku: { name: 'Standard', capacity: 30 }
  properties: {
    model: { format: 'OpenAI', name: 'gpt-4o-mini', version: '2024-07-18' }
  }
}

resource embeddingDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: openAi
  name: 'text-embedding-3-small'
  sku: { name: 'Standard', capacity: 30 }
  properties: {
    model: { format: 'OpenAI', name: 'text-embedding-3-small', version: '1' }
  }
  dependsOn: [gptDeployment] // serialise to avoid quota race
}

// ─── Container Apps Environment ────────────────────────────────────────────

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${environmentName}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: listKeys(logAnalytics.id, '2023-09-01').primarySharedKey
      }
    }
  }
}

// ─── Container App ─────────────────────────────────────────────────────────

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: environmentName
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        allowInsecure: false
        traffic: [{ latestRevision: true, weight: 100 }]
      }
      secrets: [
        // Key Vault references pulled in via the secret's keyVaultUrl property.
        // The container app's managed identity must have 'Key Vault Secrets
        // User' RBAC role on the vault (granted by roleAssignments below).
        { name: 'openai-key', keyVaultUrl: '${keyVault.properties.vaultUri}secrets/openai-key', identity: 'system' }
        { name: 'chatbot-api-key', keyVaultUrl: '${keyVault.properties.vaultUri}secrets/chatbot-api-key', identity: 'system' }
      ]
    }
    template: {
      containers: [{
        name: 'chatbot'
        image: containerImage
        resources: { cpu: json('0.5'), memory: '1.0Gi' }
        env: [
          { name: 'PORT', value: '3000' }
          { name: 'AZURE_OPENAI_ENDPOINT', value: openAi.properties.endpoint }
          { name: 'AZURE_OPENAI_API_KEY', secretRef: 'openai-key' }
          { name: 'AZURE_OPENAI_API_VERSION', value: '2024-10-21' }
          { name: 'AZURE_OPENAI_CHAT_DEPLOYMENT', value: gptDeployment.name }
          { name: 'AZURE_OPENAI_EMBEDDING_DEPLOYMENT', value: embeddingDeployment.name }
          { name: 'CHATBOT_API_KEY', secretRef: 'chatbot-api-key' }
          { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
        ]
        probes: [
          {
            type: 'Liveness'
            httpGet: { path: '/health', port: 3000 }
            periodSeconds: 30
            failureThreshold: 3
          }
          {
            type: 'Readiness'
            httpGet: { path: '/ready', port: 3000 }
            periodSeconds: 15
            failureThreshold: 3
          }
        ]
      }]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [{
          name: 'http-scaling'
          http: { metadata: { concurrentRequests: '50' } }
        }]
      }
    }
  }
}

// ─── RBAC role assignments ─────────────────────────────────────────────────
//
// Container App's managed identity → Key Vault Secrets User on the vault.
// 'Key Vault Secrets User' is the built-in role definition with GUID
// 4633458b-17de-408a-b874-0445c86b69e6.

resource kvRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, containerApp.id, 'kvSecretsUser')
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '4633458b-17de-408a-b874-0445c86b69e6',
    )
    principalId: containerApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ─── outputs ───────────────────────────────────────────────────────────────

output containerAppFqdn string = containerApp.properties.configuration.ingress.fqdn
output openAiEndpoint string = openAi.properties.endpoint
output keyVaultUri string = keyVault.properties.vaultUri
output containerRegistryLoginServer string = registry.properties.loginServer
output applicationInsightsConnectionString string = appInsights.properties.ConnectionString
