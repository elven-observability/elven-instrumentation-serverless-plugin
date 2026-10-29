# Instrumentação Lambda com Serverless Framework e Elven Plugin

Guia prático para instrumentar funções AWS Lambda com o `elven-instrumentation-serverless-plugin`, incluindo seleção automática de layers para `node`, `python`, `ruby`, `javaagent` e `javawrapper`.

Fonte pública de releases: [elven-instrumentation-serverless-plugin](https://github.com/elven-observability/elven-instrumentation-serverless-plugin).
Documentação central: [Elven Docs](https://docs.elven.works/elven-observability/integracao-e-instrumentacao/javascript/instrumentacao-lambda-com-serverless-framework-e-elven-plugin.html), mantida no [Git](https://github.com/elvenworks-ps/docs.elven.works).
A versão [1.2.0 foi publicada no npm](https://www.npmjs.com/package/elven-instrumentation-serverless-plugin/v/1.2.0), com artefato e proveniência conferidos. A [release no Git](https://github.com/elven-observability/elven-instrumentation-serverless-plugin/releases/tag/v1.2.0) contém os recibos de integridade e assinatura. Isso não certifica a execução das layers remotas.

Este espelho contém apenas os arquivos revisados da biblioteca e seus testes,
sem o histórico do repositório privado. O código de transformação foi extraído
do commit revisado `d6eb7cb0bb18a13c81070a757300f625995c75e0`.
O empacotamento local foi qualificado com Serverless Framework 3.40.0, Node 20
e Python 3.11 como runtimes declarados, sem chamadas AWS. O processo de build
usou Node 26; ele não executou funções nesses runtimes. Framework 4.46.0,
execução real das layers e disponibilidade regional exigem homologação própria.
Os runtimes dos exemplos abaixo são configurações; não ampliam essa matriz de execução qualificada.

---

## Visão geral

O plugin automatiza três partes da instrumentação:

1. Adiciona a layer OpenTelemetry correta para o runtime da função.
2. Adiciona a Elven Log Extension correta para `x86_64` ou `arm64`.
3. Injeta as variáveis de ambiente de traces e logs sem sobrescrever o que já existe na função.

Por padrão, a Elven Log Extension usa `EXPORTER_MODE=otlp` e reaproveita as mesmas variáveis OTEL da instrumentação:
`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_RESOURCE_ATTRIBUTES` e, quando configurado, `OTEL_EXPORTER_OTLP_HEADERS`.
Use `exporter_mode: loki` ou `exporter_mode: both` apenas para manter o modo legado ou uma janela de dual-write.

O runtime efetivo é resolvido nesta ordem:

1. `functions.<nome>.elvenRuntime`
2. `custom.elvenLayerPlugin.runtime`
3. Família de `functions.<nome>.runtime` ou `provider.runtime`
4. `node`, apenas quando nenhum runtime real foi informado

Uma seleção explícita incompatível faz o plugin avisar e ignorar a função, sem injetar uma layer de outra linguagem.

---

## Instalação

```bash
npm install --save-dev elven-instrumentation-serverless-plugin@1.2.0
```

```yaml
plugins:
  - elven-instrumentation-serverless-plugin
```

---

## Quick start

### Serviço homogêneo

```yaml
service: minha-api

provider:
  name: aws
  runtime: python3.12
  region: us-east-1
  stage: ${opt:stage, 'dev'}

plugins:
  - elven-instrumentation-serverless-plugin

custom:
  elvenLayerPlugin:
    collector_endpoint: "https://otel-collector.minha-infra.com:4318"
    runtime: python

functions:
  hello:
    handler: handler.hello
```

### Serviço misto

```yaml
service: mixed-service

provider:
  name: aws
  runtime: nodejs22.x
  region: us-east-1

plugins:
  - elven-instrumentation-serverless-plugin

custom:
  elvenLayerPlugin:
    collector_endpoint: "https://otel-collector.minha-infra.com:4318"

functions:
  api:
    handler: src/api.handler

  worker:
    runtime: python3.14
    handler: src/worker.handler
    elvenRuntime: python
    architecture: arm64

  billing:
    runtime: java21
    handler: com.example.BillingHandler::handleRequest
    elvenRuntime: javaagent
```

### Output esperado

```text
✅ [Elven] Instrumented function: mixed-service_dev_api (runtime=node, arch=x86_64)
✅ [Elven] Instrumented function: mixed-service_dev_worker (runtime=python, arch=arm64)
✅ [Elven] Instrumented function: mixed-service_dev_billing (runtime=javaagent, arch=x86_64)
📍 [Elven] Region: us-east-1
🧩 [Elven] Default runtime: node
🏗️  [Elven] Default architecture: x86_64
🚚 [Elven] Log exporter mode: otlp
📦 [Elven] Instrumented functions: 3
```

---

## Configuração do plugin

Todas as opções ficam em `custom.elvenLayerPlugin`:

```yaml
custom:
  elvenLayerPlugin:
    tenant: "seu-tenant-id"
    token: "seu-api-token"
    collector_endpoint: "https://otel-collector.minha-infra.com:4318"

    region: "us-east-1"
    runtime: "node"                    # node | python | ruby | javaagent | javawrapper
    architecture: "x86_64"
    exporter_mode: "otlp"              # otlp | loki | both
    logs_endpoint: "https://loki.elvenobservability.com"
    otlp_logs_endpoint: "https://collector.exemplo.com/v1/logs"
    otlp_headers: "Authorization=Bearer token"
    resource_attributes: "deployment.environment=prod"
    log_version: "9"
    log_version_arm64: "8"
    enabled_instrumentations: "http,express,pg"
    disabled_instrumentations: "flask,sidekiq"
    layers:
      - "arn:aws:lambda:us-east-1:111111111111:layer:custom-otel:5"
      - "arn:aws:lambda:us-east-1:111111111111:layer:custom-log:9"
```

### Opções disponíveis

| Opção | Default | Descrição |
| --- | --- | --- |
| `enabled` | `true` | `false` não altera as funções |
| `tenant` | `""` | Tenant explícito; não existe tenant compartilhado padrão |
| `token` | `""` | Token de autenticação |
| `collector_endpoint` | `""` | URL do seu collector OTLP |
| `region` | região efetiva do provider, depois `us-east-1` | Região usada nos ARNs das layers |
| `runtime` | inferido por função | Família explícita opcional |
| `architecture` | `x86_64` | Arquitetura padrão do serviço |
| `exporter_mode` | `otlp` | Modo da Elven Log Extension: `otlp`, `loki` ou `both` |
| `logs_endpoint` | `""` | URL base do Loki; configure seu destino explicitamente |
| `otlp_logs_endpoint` | `""` | Endpoint OTLP específico para logs; se vazio, a extension deriva `/v1/logs` de `collector_endpoint` |
| `otlp_headers` | `""` | Headers OTLP opcionais, no formato `chave=valor,chave2=valor2` |
| `resource_attributes` | `""` | Atributos extras anexados a `OTEL_RESOURCE_ATTRIBUTES` |
| `log_version` | `9` | Versão da log extension para `x86_64` |
| `log_version_arm64` | `8` | Versão da log extension para `arm64` |
| `enabled_instrumentations` | lista default Node | Instrumentações habilitadas para Node.js |
| `disabled_instrumentations` | `""` | Instrumentações desabilitadas para Node, Python ou Ruby |
| `layers` | automático | Override completo das layers para todas as funções instrumentadas |

### Valores suportados para `runtime`

| Valor | Observação |
| --- | --- |
| `node` | valor recomendado para Node.js |
| `nodejs` | alias aceito para `node` |
| `python` | usa a layer Python |
| `ruby` | usa a layer Ruby |
| `javaagent` | usa o Java agent |
| `javawrapper` | usa o Java wrapper |

---

## Controle por função

### Desabilitar a instrumentação

```yaml
functions:
  internal:
    handler: src/internal.handler
    disableElven: true
```

### Escolher runtime por função

```yaml
functions:
  api:
    handler: src/api.handler
    # usa o runtime global

  worker:
    handler: src/worker.handler
    elvenRuntime: python

  billing:
    handler: com.example.BillingHandler::handleRequest
    elvenRuntime: javawrapper
```

### Sobrescrever variáveis manualmente

O plugin não sobrescreve variáveis de ambiente já definidas no provider ou na função, incluindo sampler, headers e `NODE_OPTIONS`:

```yaml
functions:
  heavy-worker:
    handler: src/worker.handler
    elvenRuntime: python
    environment:
      OTEL_TRACES_SAMPLER: "traceidratio"
      OTEL_TRACES_SAMPLER_ARG: "0.1"
```

---

## Variáveis de ambiente injetadas

### Comuns a todos os runtimes

| Variável | Valor |
| --- | --- |
| `AWS_LAMBDA_EXEC_WRAPPER` | `/opt/otel-handler` |
| `OTEL_SERVICE_NAME` | `{service}_{stage}_{function}` |
| `OTEL_TRACES_SAMPLER` | `parentbased_always_on`: respeita a decisão do pai; configure uma taxa adequada ao volume |
| `OTEL_LAMBDA_TRACE_MODE` | `capture` |
| `OTEL_PROPAGATORS` | `tracecontext,baggage,xray` |
| `OTEL_RESOURCE_ATTRIBUTES` | `service.name=...,environment=...,tenant.id=...` + `resource_attributes` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `collector_endpoint` |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | `otlp_logs_endpoint`, quando configurado |
| `OTEL_EXPORTER_OTLP_HEADERS` | `otlp_headers`, quando configurado |
| `EXPORTER_MODE` | `exporter_mode` |
| `TENANT_ID` | `tenant` |
| `SERVICE_NAME` | `{service}_{stage}_{function}` |
| `RESOURCES_ATTRIBUTES` | `service=...,environment=...` |
| `API_TOKEN` | `token` |
| `LOKI_URL` | `logs_endpoint` |
| `LOKI_TENANT_ID` | `tenant` |
| `LOKI_AUTH_TOKEN` | `token` |
| `DEBUG` | `false` |

### Específicas por runtime

| Runtime | Variáveis |
| --- | --- |
| `node` | `OTEL_NODE_ENABLED_INSTRUMENTATIONS`, `OTEL_NODE_DISABLED_INSTRUMENTATIONS` |
| `python` | `OTEL_PYTHON_DISABLED_INSTRUMENTATIONS` |
| `ruby` | `OTEL_RUBY_DISABLED_INSTRUMENTATIONS` |
| `javaagent` | `OTEL_INSTRUMENTATION_COMMON_DEFAULT_ENABLED=true` |
| `javawrapper` | `OTEL_INSTRUMENTATION_COMMON_DEFAULT_ENABLED=true` |

> `enabled_instrumentations` é uma opção específica de Node.js. Para Python e Ruby, o plugin só mapeia `disabled_instrumentations`.

---

## Layers padrão

### OpenTelemetry por runtime

| Runtime | ARN |
| --- | --- |
| `node` | `arn:aws:lambda:{region}:184161586896:layer:opentelemetry-nodejs-0_24_0:1` |
| `python` | `arn:aws:lambda:{region}:184161586896:layer:opentelemetry-python-0_22_0:1` |
| `ruby` | `arn:aws:lambda:{region}:184161586896:layer:opentelemetry-ruby-0_16_0:1` |
| `javaagent` | `arn:aws:lambda:{region}:184161586896:layer:opentelemetry-javaagent-0_22_0:1` |
| `javawrapper` | `arn:aws:lambda:{region}:184161586896:layer:opentelemetry-javawrapper-0_22_0:1` |

`layer-manifest.json` registra as fontes oficiais verificadas em 29/10/2026. Isto comprova metadados de release, não disponibilidade AWS em todas as regiões nem execução de sua função. Ruby padrão aceita 3.3/3.4/4.0 e não é aplicado em `me-central-1`. Partições China/GovCloud/isoladas exigem layers compatíveis explícitas. Não é realizada chamada AWS durante o empacotamento.

### Elven Log Extension por arquitetura

| Arquitetura | ARN |
| --- | --- |
| `x86_64` | `arn:aws:lambda:{region}:911167927290:layer:elven-lambda-log-extension:{version}` |
| `arm64` | `arn:aws:lambda:{region}:911167927290:layer:elven-lambda-log-extension-arm64:{version}` |

### Override completo das layers

Ao definir `custom.elvenLayerPlugin.layers`, o plugin usa essa lista no lugar das layers automáticas e preserva as layers já declaradas no provider ou na função:

```yaml
custom:
  elvenLayerPlugin:
    runtime: ruby
    layers:
      - "arn:aws:lambda:us-east-1:111111111111:layer:custom-otel:5"
      - "arn:aws:lambda:us-east-1:111111111111:layer:custom-log:9"
```

As variáveis de ambiente continuam sendo resolvidas pelo runtime efetivo.

---

## Exemplos completos

### Node.js padrão

```yaml
provider:
  name: aws
  runtime: nodejs22.x

custom:
  elvenLayerPlugin:
    tenant: ${env:ELVEN_TENANT}
    token: ${env:ELVEN_TOKEN}
    collector_endpoint: "https://otel-collector.minha-infra.com:4318"
    runtime: node
```

### Python com arm64

```yaml
provider:
  name: aws
  runtime: python3.12
  architecture: arm64

custom:
  elvenLayerPlugin:
    tenant: ${env:ELVEN_TENANT}
    token: ${env:ELVEN_TOKEN}
    collector_endpoint: "https://otel-collector.minha-infra.com:4318"
    runtime: python
```

### Serviço misto Node + Python + Java

```yaml
custom:
  elvenLayerPlugin:
    tenant: ${env:ELVEN_TENANT}
    token: ${env:ELVEN_TOKEN}
    collector_endpoint: "https://otel-collector.minha-infra.com:4318"
    runtime: node

functions:
  api:
    handler: src/api.handler

  worker:
    handler: src/worker.handler
    elvenRuntime: python

  billing:
    handler: com.example.BillingHandler::handleRequest
    elvenRuntime: javaagent
```

---

## Troubleshooting

### Erro de layer inexistente

Verifique:

1. `region`
2. `log_version` e `log_version_arm64`
3. se o runtime efetivo está correto para a função

Exemplo para validar a layer Node:

```bash
aws lambda get-layer-version \
  --layer-name arn:aws:lambda:us-east-1:184161586896:layer:opentelemetry-nodejs-0_24_0 \
  --version-number 1 \
  --region us-east-1 \
  --query "LayerVersionArn"
```

### Warning de runtime incompatível

Exemplo típico:

- `provider.runtime: python3.12`
- `custom.elvenLayerPlugin.runtime: node`

Nesse caso o plugin avisa e não modifica a função. Corrija a família ou remova a seleção explícita para permitir inferência.

## Segurança e recursos

- `enabled: false`, `disableElven: true` ou `OTEL_SDK_DISABLED=true` efetivo preservam as definições sem injeção.
- Funções de imagem, famílias desconhecidas e funções com outro `AWS_LAMBDA_EXEC_WRAPPER` são ignoradas. Não há substituição do wrapper existente.
- Layers explícitas de uma mesma família permanecem fixadas, mesmo antigas. O plugin não duplica nem atualiza uma layer fixada silenciosamente; isso também significa que o operador deve revisar seus advisories.
- O limite AWS de cinco layers é verificado antes de modificar a função. Outra layer OTel de linguagem diferente faz a função ser ignorada.
- Credenciais não são impressas pelo plugin. Variáveis e templates empacotados ainda contêm os valores resolvidos; use o mecanismo de secrets apropriado e restrinja os artefatos do Serverless.
- Nenhum endpoint público, token ou tenant é inventado. Sem destino configurado, não há garantia de entrega; SDKs podem usar seus próprios defaults locais.
- Configure o conjunto destino/protocolo/headers/credenciais/tenant em um único lugar: no ambiente do provider/função ou no plugin. Se já houver configuração de transporte herdada e o plugin também fornecer parte desse conjunto, a função é ignorada com aviso e permanece inalterada. Não se mesclam credenciais de um destino com outro, mesmo quando ambos usam a mesma família OTLP/Loki. `API_TOKEN` herdado também é tratado como configuração existente; não use o plugin para reutilizar uma credencial de negócio por acidente.
- O plugin atua no empacotamento, não implementa fila, redaction ou orçamento de memória no runtime. Qualifique cada layer, sampling, volume, cold start e flush em homologação. Não há promessa de overhead zero ou de ausência universal de CVEs.
- `exporter_mode: both` duplica o envio de logs intencionalmente; reserve para migração controlada.

## Validação

Execute `npm ci --ignore-scripts`, `npm test`, `npm audit --omit=dev` e `npm pack --dry-run`. Os testes cobrem transformação/idempotência/configuração, não executam uma Lambda nem validam credenciais, ARNs, arquitetura nativa ou permissões AWS.

### Traces ou logs não aparecem

Verifique:

1. `collector_endpoint`
2. a autenticação exigida pelo collector; `tenant`/`token` são opcionais no OTLP e devem ser avaliados no modo Loki explícito
3. se a função recebeu a layer OTel correta para o runtime
4. se `LOKI_URL` está configurado como URL base, sem `/loki/api/v1/push`

---

## FAQ

**Preciso configurar cada função individualmente?**  
Não. Só use `elvenRuntime` quando a função fugir do runtime global.

**O plugin funciona com outros runtimes além de Node.js?**  
Sim. Há suporte automático para `node`, `python`, `ruby`, `javaagent` e `javawrapper`.

**O plugin sobrescreve minhas layers?**  
Não. Ele só adiciona o que falta e evita duplicação.

**O plugin sobrescreve minhas variáveis de ambiente?**  
Não. Variáveis já definidas na função têm prioridade.

**Posso continuar usando layers customizadas?**  
Sim. Use `custom.elvenLayerPlugin.layers`.

**Como atualizo a versão das layers padrão?**  
Para a log extension, altere `log_version` e `log_version_arm64`. Para a layer OTel, use `layers` se precisar sair dos defaults do plugin.

**Quais runtimes do Lambda fazem mais sentido hoje?**  
Em abril de 2026, para novas funções AWS Lambda, a recomendação geral é preferir `nodejs22.x` ou `nodejs24.x`, `python3.12+`, `java21` e `ruby3.3+`, conforme compatibilidade do seu projeto e da sua versão do Serverless Framework.
