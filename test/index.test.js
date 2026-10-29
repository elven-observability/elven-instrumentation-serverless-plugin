const test = require("node:test");
const assert = require("node:assert/strict");

const ElvenLayerPlugin = require("../index.js");
const manifest = require("../layer-manifest.json");

test("release manifest pins primary source provenance for every supported family", () => {
  for (const release of Object.values(manifest.versions)) {
    assert.match(release.source, /^https:\/\/github.com\/open-telemetry\/opentelemetry-lambda\/releases\/tag\//);
    assert.match(release.name, /^opentelemetry-[a-z]+-\d+_\d+_\d+$/);
    assert.match(release.version, /^\d+$/);
  }
});

test("infers each real runtime and uses provider region", () => {
  const { plugin, serverless } = createPlugin({
    provider: { runtime: "nodejs24.x", region: "sa-east-1" },
    functions: {
      api: { handler: "api.handler" },
      worker: { runtime: "python3.14", handler: "worker.handler" },
      billing: { runtime: "java21", handler: "Billing::handleRequest" },
      job: { runtime: "ruby3.4", handler: "job.handler" },
    },
  });
  plugin.applyElvenLayer();
  for (const [name, family] of [["api", "nodejs"], ["worker", "python"], ["billing", "javaagent"], ["job", "ruby"]]) {
    assert.match(serverless.service.functions[name].layers[0], new RegExp(`:sa-east-1:.*:opentelemetry-${family}-`));
  }
});

test("preserves inherited environment, layer pins and repeats idempotently", () => {
  const oldOtel = "arn:aws:lambda:sa-east-1:184161586896:layer:opentelemetry-nodejs-0_21_0:1";
  const oldLogs = "arn:aws:lambda:sa-east-1:911167927290:layer:elven-lambda-log-extension:8";
  const environment = {
    NODE_OPTIONS: "--require ./application-hook.js",
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://existing.example.test",
    OTEL_EXPORTER_OTLP_HEADERS: "Authorization=private-value",
    OTEL_TRACES_SAMPLER: "parentbased_traceidratio",
    OTEL_RESOURCE_ATTRIBUTES: "service.name=owned,tenant.id=owned",
    API_TOKEN: "owned",
  };
  const { plugin, serverless, logs } = createPlugin({
    provider: { runtime: "nodejs22.x", environment, layers: [oldOtel, oldLogs] },
    custom: {},
    functions: { api: { handler: "api.handler" } },
  });
  plugin.applyElvenLayer();
  const snapshot = JSON.stringify(serverless.service.functions);
  plugin.applyElvenLayer();
  assert.equal(JSON.stringify(serverless.service.functions), snapshot);
  assert.deepEqual(serverless.service.functions.api.layers, [oldOtel, oldLogs]);
  for (const key of Object.keys(environment)) assert.equal(serverless.service.functions.api.environment[key], undefined);
  assert.deepEqual(serverless.service.provider.environment, environment);
  assert.equal(logs.some(message => /private-value/.test(message)), false);
});

test("never combines inherited transport ownership with plugin destinations or credentials", () => {
  const cases = [
    { environment: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector-a.example.test" }, custom: { collector_endpoint: "https://collector-b.example.test", otlp_headers: "x-api-key=synthetic-for-b" } },
    { environment: { LOKI_URL: "https://logs-a.example.test" }, custom: { logs_endpoint: "https://logs-b.example.test", token: "synthetic-for-b", exporter_mode: "loki" } },
    { environment: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://logs-a.example.test/v1/logs" }, custom: { otlp_headers: "x-api-key=synthetic-for-b" } },
    { environment: { OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=synthetic-for-a" }, custom: { collector_endpoint: "https://collector-b.example.test" } },
    { environment: { OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" }, custom: { collector_endpoint: "https://collector-b.example.test", token: "synthetic-for-b" } },
    { environment: { OTEL_EXPORTER_OTLP_ENDPOINT: "" }, custom: { collector_endpoint: "https://collector-b.example.test", otlp_headers: "x-api-key=synthetic-for-b" } },
    { environment: { API_TOKEN: "synthetic-application-credential" }, custom: { logs_endpoint: "https://logs-b.example.test" } },
  ];
  for (const scenario of cases) {
    for (const location of ["provider", "function"]) {
      const { plugin, serverless, logs } = createPlugin({ custom: scenario.custom,
        provider: location === "provider" ? { environment: scenario.environment } : {},
        functions: { api: { handler: "api.handler", ...(location === "function" ? { environment: scenario.environment } : {}) } },
      });
      const before = JSON.stringify(serverless.service);
      plugin.applyElvenLayer();
      assert.equal(JSON.stringify(serverless.service), before);
      assert.ok(logs.some(message => message.includes("configure destination, protocol, credentials and tenant together")));
      assert.ok(logs.every(message => !/synthetic-for-|synthetic-application-credential/.test(message)));
    }
  }
});

test("skip paths leave function definitions byte-equivalent", () => {
  const scenarios = [
    { custom: { enabled: false, runtime: "invalid" }, functions: { job: { handler: "job.handler" } } },
    { functions: { job: { handler: "job.handler", disableElven: true } } },
    { provider: { environment: { OTEL_SDK_DISABLED: "TRUE" } }, functions: { job: { handler: "job.handler" } } },
    { functions: { job: { image: { uri: "example/image:version" } } } },
    { provider: { runtime: "dotnet10" }, functions: { job: { handler: "Job::handler" } } },
    { provider: { runtime: "python3.14" }, custom: { runtime: "node" }, functions: { job: { handler: "job.handler" } } },
    { provider: { environment: { AWS_LAMBDA_EXEC_WRAPPER: "/opt/owned" } }, functions: { job: { handler: "job.handler" } } },
    { provider: { architecture: "other" }, functions: { job: { handler: "job.handler" } } },
    { provider: { region: "cn-north-1" }, functions: { job: { handler: "job.handler" } } },
    { provider: { runtime: "ruby3.2" }, functions: { job: { handler: "job.handler" } } },
    { provider: { runtime: "ruby3.4", region: "me-central-1" }, functions: { job: { handler: "job.handler" } } },
    { functions: { job: { handler: "job.handler", layers: Array.from({ length: 5 }, (_, i) => `arn:aws:lambda:us-east-1:111111111111:layer:owned-${i}:1`) } } },
    { functions: { job: { handler: "job.handler", layers: ["arn:aws:lambda:us-east-1:184161586896:layer:opentelemetry-python-0_22_0:1"] } } },
  ];
  for (const scenario of scenarios) {
    const { plugin, serverless } = createPlugin(scenario);
    const snapshot = JSON.stringify(serverless.service.functions);
    plugin.applyElvenLayer();
    assert.equal(JSON.stringify(serverless.service.functions), snapshot, JSON.stringify(scenario));
  }
});

test("does not invent a shared tenant or a collector destination", () => {
  const { plugin, serverless } = createPlugin({ functions: { api: { handler: "api.handler" } } });
  plugin.applyElvenLayer();
  const environment = serverless.service.functions.api.environment;
  for (const key of ["LOKI_URL", "TENANT_ID", "LOKI_TENANT_ID", "API_TOKEN", "LOKI_AUTH_TOKEN", "OTEL_EXPORTER_OTLP_ENDPOINT"]) {
    assert.equal(environment[key], undefined);
  }
  assert.equal(environment.OTEL_RESOURCE_ATTRIBUTES.includes("tenant.id="), false);
  assert.equal(environment.OTEL_TRACES_SAMPLER, "parentbased_always_on");
});

test("preserves published OTLP mode, headers and extra resource attributes", () => {
  const { plugin, serverless } = createPlugin({
    custom: {
      collector_endpoint: "https://collector.example.test/base", exporter_mode: "both",
      tenant: "test-tenant", otlp_headers: "X-Test=synthetic", otlp_logs_endpoint: "https://collector.example.test/base/v1/logs",
      resource_attributes: "service.name=explicit,deployment.environment=qa",
    },
    functions: { api: { handler: "api.handler" } },
  });
  plugin.applyElvenLayer();
  const environment = serverless.service.functions.api.environment;
  assert.equal(environment.EXPORTER_MODE, "both");
  assert.equal(environment.OTEL_EXPORTER_OTLP_HEADERS, "X-Test=synthetic");
  assert.equal(environment.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, "https://collector.example.test/base/v1/logs");
  assert.equal(environment.OTEL_RESOURCE_ATTRIBUTES.split(",").filter(part => part.startsWith("service.name=")).length, 1);
  assert.match(environment.OTEL_RESOURCE_ATTRIBUTES, /tenant.id=test-tenant/);
});

function createPlugin({
  custom = {},
  functions = {},
  provider = {},
  serviceName = "demo-service",
} = {}) {
  const logs = [];
  const serverless = {
    cli: {
      log(message) {
        logs.push(message);
      },
    },
    service: {
      getServiceName() {
        return serviceName;
      },
      provider: {
        stage: "dev",
        ...provider,
      },
      functions: JSON.parse(JSON.stringify(functions)),
      custom: {
        elvenLayerPlugin: custom,
      },
    },
  };

  return {
    logs,
    plugin: new ElvenLayerPlugin(serverless),
    serverless,
  };
}

test("applies node instrumentation by default", () => {
  const { plugin, serverless } = createPlugin({
    custom: {
      collector_endpoint: "https://collector.example.com:4318",
    },
    functions: {
      hello: {
        handler: "handler.hello",
      },
    },
  });

  plugin.applyElvenLayer();

  const hello = serverless.service.functions.hello;
  assert.deepEqual(hello.layers, [
    "arn:aws:lambda:us-east-1:184161586896:layer:opentelemetry-nodejs-0_24_0:1",
    "arn:aws:lambda:us-east-1:911167927290:layer:elven-lambda-log-extension:9",
  ]);
  assert.equal(hello.environment.OTEL_NODE_ENABLED_INSTRUMENTATIONS.includes("express"), true);
  assert.equal(
    hello.environment.OTEL_SERVICE_NAME,
    "demo-service_dev_hello"
  );
  assert.equal(hello.environment.OTEL_PYTHON_DISABLED_INSTRUMENTATIONS, undefined);
  assert.equal(hello.environment.OTEL_RUBY_DISABLED_INSTRUMENTATIONS, undefined);
  assert.equal(hello.environment.OTEL_INSTRUMENTATION_COMMON_DEFAULT_ENABLED, undefined);
});

test("supports service-wide runtimes for python, ruby and java", () => {
  const scenarios = [
    {
      runtime: "python",
      expectedLayer:
        "arn:aws:lambda:us-east-1:184161586896:layer:opentelemetry-python-0_22_0:1",
      expectedEnvKey: "OTEL_PYTHON_DISABLED_INSTRUMENTATIONS",
    },
    {
      runtime: "ruby",
      expectedLayer:
        "arn:aws:lambda:us-east-1:184161586896:layer:opentelemetry-ruby-0_16_0:1",
      expectedEnvKey: "OTEL_RUBY_DISABLED_INSTRUMENTATIONS",
    },
    {
      runtime: "javaagent",
      expectedLayer:
        "arn:aws:lambda:us-east-1:184161586896:layer:opentelemetry-javaagent-0_22_0:1",
      expectedEnvKey: "OTEL_INSTRUMENTATION_COMMON_DEFAULT_ENABLED",
    },
    {
      runtime: "javawrapper",
      expectedLayer:
        "arn:aws:lambda:us-east-1:184161586896:layer:opentelemetry-javawrapper-0_22_0:1",
      expectedEnvKey: "OTEL_INSTRUMENTATION_COMMON_DEFAULT_ENABLED",
    },
  ];

  for (const scenario of scenarios) {
    const { plugin, serverless } = createPlugin({
      custom: {
        collector_endpoint: "https://collector.example.com:4318",
        disabled_instrumentations: "flask,sidekiq",
        runtime: scenario.runtime,
      },
      functions: {
        job: {
          handler: "handler.job",
        },
      },
    });

    plugin.applyElvenLayer();

    const job = serverless.service.functions.job;
    assert.equal(job.layers[0], scenario.expectedLayer);
    assert.equal(job.layers[1], "arn:aws:lambda:us-east-1:911167927290:layer:elven-lambda-log-extension:9");
    assert.equal(job.environment[scenario.expectedEnvKey] !== undefined, true);
    assert.equal(job.environment.OTEL_NODE_ENABLED_INSTRUMENTATIONS, undefined);
  }
});

test("accepts nodejs as a runtime alias and supports mixed functions", () => {
  const { plugin, serverless } = createPlugin({
    custom: {
      collector_endpoint: "https://collector.example.com:4318",
      runtime: "nodejs",
      disabled_instrumentations: "django,flask",
    },
    provider: {
      architecture: "x86_64",
    },
    functions: {
      api: {
        handler: "api.handler",
      },
      worker: {
        handler: "worker.handler",
        architecture: "arm64",
        elvenRuntime: "python",
      },
      billing: {
        handler: "com.example.Billing::handleRequest",
        elvenRuntime: "javaagent",
      },
    },
  });

  plugin.applyElvenLayer();

  const { api, worker, billing } = serverless.service.functions;
  assert.equal(
    api.layers[0],
    "arn:aws:lambda:us-east-1:184161586896:layer:opentelemetry-nodejs-0_24_0:1"
  );
  assert.equal(
    worker.layers[0],
    "arn:aws:lambda:us-east-1:184161586896:layer:opentelemetry-python-0_22_0:1"
  );
  assert.equal(
    worker.layers[1],
    "arn:aws:lambda:us-east-1:911167927290:layer:elven-lambda-log-extension-arm64:8"
  );
  assert.equal(
    worker.environment.OTEL_PYTHON_DISABLED_INSTRUMENTATIONS,
    "django,flask"
  );
  assert.equal(
    billing.environment.OTEL_INSTRUMENTATION_COMMON_DEFAULT_ENABLED,
    "true"
  );
});

test("keeps custom layers override and still applies runtime-specific environment variables", () => {
  const { plugin, serverless } = createPlugin({
    custom: {
      collector_endpoint: "https://collector.example.com:4318",
      runtime: "python",
      disabled_instrumentations: "flask",
      layers: [
        "arn:aws:lambda:us-east-1:111111111111:layer:custom-otel:5",
        "arn:aws:lambda:us-east-1:111111111111:layer:custom-log:9",
      ],
    },
    functions: {
      worker: {
        handler: "worker.handler",
      },
    },
  });

  plugin.applyElvenLayer();

  const worker = serverless.service.functions.worker;
  assert.deepEqual(worker.layers, [
    "arn:aws:lambda:us-east-1:111111111111:layer:custom-otel:5",
    "arn:aws:lambda:us-east-1:111111111111:layer:custom-log:9",
  ]);
  assert.equal(worker.environment.OTEL_PYTHON_DISABLED_INSTRUMENTATIONS, "flask");
  assert.equal(worker.environment.OTEL_NODE_ENABLED_INSTRUMENTATIONS, undefined);
});

test("preserves existing layers and environment variables without duplication", () => {
  const { plugin, serverless } = createPlugin({
    custom: {
      collector_endpoint: "https://collector.example.com:4318",
      runtime: "ruby",
      disabled_instrumentations: "sidekiq",
    },
    functions: {
      worker: {
        handler: "worker.handler",
        layers: [
          "arn:aws:lambda:us-east-1:184161586896:layer:opentelemetry-ruby-0_16_0:1",
          "arn:aws:lambda:us-east-1:911167927290:layer:elven-lambda-log-extension:9",
          "arn:aws:lambda:us-east-1:999999999999:layer:existing:3",
        ],
        environment: {
          OTEL_SERVICE_NAME: "custom-service-name",
        },
      },
    },
  });

  plugin.applyElvenLayer();

  const worker = serverless.service.functions.worker;
  assert.deepEqual(worker.layers, [
    "arn:aws:lambda:us-east-1:184161586896:layer:opentelemetry-ruby-0_16_0:1",
    "arn:aws:lambda:us-east-1:911167927290:layer:elven-lambda-log-extension:9",
    "arn:aws:lambda:us-east-1:999999999999:layer:existing:3",
  ]);
  assert.equal(worker.environment.OTEL_SERVICE_NAME, "custom-service-name");
  assert.equal(worker.environment.OTEL_RUBY_DISABLED_INSTRUMENTATIONS, "sidekiq");
});

test("throws on invalid global and per-function runtimes", () => {
  const invalidGlobal = createPlugin({
    custom: {
      collector_endpoint: "https://collector.example.com:4318",
      runtime: "go",
    },
    functions: {
      hello: {
        handler: "handler.hello",
      },
    },
  });

  assert.throws(
    () => invalidGlobal.plugin.applyElvenLayer(),
    /Invalid runtime 'go' in custom\.elvenLayerPlugin\.runtime/
  );

  const invalidFunction = createPlugin({
    custom: {
      collector_endpoint: "https://collector.example.com:4318",
    },
    functions: {
      hello: {
        handler: "handler.hello",
        elvenRuntime: "dotnet",
      },
    },
  });

  assert.throws(
    () => invalidFunction.plugin.applyElvenLayer(),
    /Invalid runtime 'dotnet' in functions\.hello\.elvenRuntime/
  );
});

test("logs runtime mismatch warnings when explicit runtime conflicts with Serverless runtime", () => {
  const { logs, plugin } = createPlugin({
    custom: {
      collector_endpoint: "https://collector.example.com:4318",
      runtime: "node",
    },
    provider: {
      runtime: "python3.12",
    },
    functions: {
      hello: {
        handler: "handler.hello",
      },
      billing: {
        handler: "billing.handler",
        runtime: "nodejs20.x",
        elvenRuntime: "javawrapper",
      },
    },
  });

  plugin.applyElvenLayer();

  assert.equal(
    logs.some((message) =>
      message.includes("Runtime mismatch for function 'hello'")
    ),
    true
  );
  assert.equal(
    logs.some((message) =>
      message.includes("Runtime mismatch for function 'billing'")
    ),
    true
  );
});
