const DEFAULT_NODE_INSTRUMENTATIONS = [
  "http",
  "express",
  "graphql",
  "grpc",
  "hapi",
  "ioredis",
  "koa",
  "mongodb",
  "mysql",
  "net",
  "pg",
  "redis",
  "memcached",
  "mongoose",
  "amqplib",
  "bunyan",
  "cassandra-driver",
  "connect",
  "kafkajs",
  "knex",
  "mysql2",
  "nestjs-core",
  "pino",
  "restify",
  "socket.io",
  "undici",
  "winston",
];

const SUPPORTED_RUNTIMES = ["node", "python", "ruby", "javaagent", "javawrapper"];

const LAYER_MANIFEST = require("./layer-manifest.json");

const DEFAULT_LOG_VERSION = "9";
const DEFAULT_LOG_VERSION_ARM64 = "8";
const DEFAULT_EXPORTER_MODE = "otlp";

const RUNTIME_ALIASES = {
  node: "node",
  nodejs: "node",
  python: "python",
  ruby: "ruby",
  javaagent: "javaagent",
  javawrapper: "javawrapper",
};

const TRANSPORT_OPTIONS = ["collector_endpoint", "logs_endpoint", "otlp_logs_endpoint", "otlp_headers", "token", "tenant", "exporter_mode"];
const SHARED_TRANSPORT_ENV = new Set(["LOKI_URL", "LOKI_AUTH_TOKEN", "LOKI_TENANT_ID", "API_TOKEN", "TENANT_ID", "EXPORTER_MODE"]);

class ElvenLayerPlugin {
  constructor(serverless) {
    this.serverless = serverless;

    if (serverless.configSchemaHandler) {
      serverless.configSchemaHandler.defineCustomProperties({
        type: "object",
        properties: {
          elvenLayerPlugin: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              tenant: { type: "string" },
              token: { type: "string" },
              collector_endpoint: { type: "string" },
              region: { type: "string" },
              runtime: { type: "string", enum: Object.keys(RUNTIME_ALIASES) },
              architecture: { type: "string", enum: ["x86_64", "arm64"] },
              exporter_mode: { type: "string", enum: ["loki", "otlp", "both"] },
              logs_endpoint: { type: "string" },
              otlp_logs_endpoint: { type: "string" },
              otlp_headers: { type: "string" },
              resource_attributes: { type: "string" },
              log_version: { type: "string" },
              log_version_arm64: { type: "string" },
              enabled_instrumentations: { type: "string" },
              disabled_instrumentations: { type: "string" },
              layers: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
      });

      serverless.configSchemaHandler.defineFunctionProperties("aws", {
        properties: {
          disableElven: { type: "boolean" },
          elvenRuntime: { type: "string", enum: Object.keys(RUNTIME_ALIASES) },
        },
      });
    }

    this.hooks = {
      "before:package:initialize": this.applyElvenLayer.bind(this),
    };
  }

  applyElvenLayer() {
    const service = this.serverless.service;
    const serviceName = service.getServiceName();
    const stage = service.provider.stage || "dev";
    const functions = service.functions || {};

    const pluginConfig = service.custom?.elvenLayerPlugin || {};
    if (pluginConfig.enabled === false) return;
    const tenant = pluginConfig.tenant || "";
    const token = pluginConfig.token || "";
    const collectorEndpoint = pluginConfig.collector_endpoint || "";
    if (!collectorEndpoint) {
      this.serverless.cli.log(
        "[Elven] AVISO: 'collector_endpoint' não configurado. Defina a URL do seu coletor OTLP em custom.elvenLayerPlugin.collector_endpoint"
      );
    }

    const region = pluginConfig.region || this.serverless.getProvider?.("aws")?.getRegion?.()
      || service.provider.region || "us-east-1";
    const logsEndpoint = pluginConfig.logs_endpoint || "";
    const logVersion = pluginConfig.log_version || DEFAULT_LOG_VERSION;
    const logVersionArm64 = pluginConfig.log_version_arm64 || DEFAULT_LOG_VERSION_ARM64;
    const exporterMode = this.normalizeExporterMode(
      pluginConfig.exporter_mode || DEFAULT_EXPORTER_MODE
    );
    const otlpLogsEndpoint = pluginConfig.otlp_logs_endpoint || "";
    const otlpHeaders = pluginConfig.otlp_headers || "";
    const resourceAttributes = pluginConfig.resource_attributes || "";

    const defaultArchitecture =
      pluginConfig.architecture ||
      process.env.LAMBDA_ARCHITECTURE ||
      service.provider.architecture ||
      "x86_64";

    const defaultRuntime = pluginConfig.runtime === undefined ? undefined : this.normalizeRuntime(
      pluginConfig.runtime, "custom.elvenLayerPlugin.runtime");

    const enabledInstrumentations =
      pluginConfig.enabled_instrumentations || DEFAULT_NODE_INSTRUMENTATIONS.join(",");
    const disabledInstrumentations = pluginConfig.disabled_instrumentations || "";

    let appliedCount = 0;

    Object.entries(functions).forEach(([funcName, func]) => {
      const fullFunctionName = `${serviceName}_${stage}_${funcName}`;

      const inheritedEnvironment = { ...service.provider.environment, ...func.environment };
      if (func.disableElven === true || String(inheritedEnvironment.OTEL_SDK_DISABLED).toLowerCase() === "true") {
        this.serverless.cli.log(
          `⚠️  [Elven] Skipping instrumentation for function: ${funcName}`
        );
        return;
      }

      if (func.image !== undefined) {
        this.serverless.cli.log(`[Elven] Skipping image function '${funcName}': layers cannot be attached.`);
        return;
      }

      const ownsTransport = Object.keys(inheritedEnvironment).some(key =>
        /^OTEL_EXPORTER_OTLP(?:_|$)/.test(key) || SHARED_TRANSPORT_ENV.has(key));
      const pluginTransport = TRANSPORT_OPTIONS.some(key => pluginConfig[key] !== undefined && pluginConfig[key] !== "");
      if (ownsTransport && pluginTransport) {
        this.serverless.cli.log(`[Elven] Skipping function '${funcName}': configure destination, protocol, credentials and tenant together in either the environment or the plugin, not both.`);
        return;
      }

      const serverlessRuntime = func.runtime || service.provider.runtime;
      const runtimeFamily = this.getServerlessRuntimeFamily(serverlessRuntime);
      if (typeof serverlessRuntime === "string" && !runtimeFamily && !func.elvenRuntime && !defaultRuntime) {
        this.serverless.cli.log(`[Elven] Skipping unsupported runtime for function '${funcName}'.`);
        return;
      }

      const resolvedRuntime = func.elvenRuntime
        ? this.normalizeRuntime(func.elvenRuntime, `functions.${funcName}.elvenRuntime`)
        : defaultRuntime || (runtimeFamily === "java" ? "javaagent" : runtimeFamily) || "node";
      const funcArchitecture = func.architecture || defaultArchitecture;

      if (this.warnAboutRuntimeConflict({
        functionName: funcName,
        resolvedRuntime,
        serverlessRuntime,
      })) return;

      if (!["x86_64", "arm64"].includes(funcArchitecture)) {
        this.serverless.cli.log(`[Elven] Skipping invalid architecture for function '${funcName}'.`);
        return;
      }
      if (inheritedEnvironment.AWS_LAMBDA_EXEC_WRAPPER !== undefined
        && inheritedEnvironment.AWS_LAMBDA_EXEC_WRAPPER !== "/opt/otel-handler") {
        this.serverless.cli.log(`[Elven] Skipping function '${funcName}': another exec wrapper owns its runtime.`);
        return;
      }
      const release = LAYER_MANIFEST.versions[resolvedRuntime];
      if (!pluginConfig.layers && (/^(?:cn-|us-gov-|us-iso)/.test(region)
        || release.excludedRegions?.includes(region)
        || (release.runtimes && serverlessRuntime && !release.runtimes.includes(serverlessRuntime)))) {
        this.serverless.cli.log(`[Elven] Skipping function '${funcName}': default layer is not verified for this region/runtime; supply compatible layers explicitly.`);
        return;
      }

      const functionLayers = pluginConfig.layers || [
        this.getOtelLayerArn(resolvedRuntime, region),
        this.getLogLayerArn(funcArchitecture, region, logVersion, logVersionArm64),
      ];
      const previousLayers = func.layers === undefined ? service.provider.layers || [] : func.layers;
      const expectedOtelIdentity = this.layerIdentity(this.getOtelLayerArn(resolvedRuntime, region));
      if (previousLayers.some(layer => {
        const identity = this.layerIdentity(layer);
        return identity?.startsWith("opentelemetry-") && identity !== expectedOtelIdentity;
      })) {
        this.serverless.cli.log(`[Elven] Skipping function '${funcName}': an existing OpenTelemetry layer belongs to another runtime.`);
        return;
      }
      const mergedLayers = [...previousLayers];
      for (const layer of functionLayers) {
        const identity = this.layerIdentity(layer);
        if (!mergedLayers.some(existing => existing === layer
          || (identity && this.layerIdentity(existing) === identity))) mergedLayers.push(layer);
      }
      if (mergedLayers.length > 5) {
        this.serverless.cli.log(`[Elven] Skipping function '${funcName}': adding instrumentation would exceed Lambda's five-layer limit.`);
        return;
      }

      const environmentVariables = this.buildEnvironmentVariables({
        collectorEndpoint,
        disabledInstrumentations,
        enabledInstrumentations,
        exporterMode,
        fullFunctionName,
        logsEndpoint,
        otlpHeaders,
        otlpLogsEndpoint,
        resourceAttributes,
        runtime: resolvedRuntime,
        stage,
        tenant,
        token,
      });

      func.layers = mergedLayers;

      if (!func.environment) {
        func.environment = {};
      }

      Object.entries(environmentVariables).forEach(([key, value]) => {
        if (inheritedEnvironment[key] === undefined && value !== "") {
          func.environment[key] = value;
        }
      });

      appliedCount += 1;
      this.serverless.cli.log(
        `✅ [Elven] Instrumented function: ${fullFunctionName} (runtime=${resolvedRuntime}, arch=${funcArchitecture})`
      );
    });

    if (appliedCount > 0) {
      this.serverless.cli.log(`📍 [Elven] Region: ${region}`);
      this.serverless.cli.log(`🧩 [Elven] Default runtime: ${defaultRuntime || "inferred from each function"}`);
      this.serverless.cli.log(`🏗️  [Elven] Default architecture: ${defaultArchitecture}`);
      this.serverless.cli.log(`🚚 [Elven] Log exporter mode: ${exporterMode}`);
      this.serverless.cli.log(`📦 [Elven] Instrumented functions: ${appliedCount}`);

      if (pluginConfig.layers) {
        this.serverless.cli.log(
          "📚 [Elven] Custom layers override is enabled for all instrumented functions."
        );
      }
    }
  }

  normalizeRuntime(runtime, source) {
    const normalized = String(runtime).trim().toLowerCase();
    const canonicalRuntime = RUNTIME_ALIASES[normalized];

    if (!canonicalRuntime) {
      throw new Error(
        `[Elven] Invalid runtime '${runtime}' in ${source}. Supported values: ${SUPPORTED_RUNTIMES.join(", ")}`
      );
    }

    return canonicalRuntime;
  }

  layerIdentity(arn) {
    if (typeof arn !== "string") return undefined;
    const match = /^arn:[^:]+:lambda:[^:]+:\d{12}:layer:([^:]+):\d+$/.exec(arn);
    if (!match || !/^(?:opentelemetry-|elven-lambda-log-extension)/.test(match[1])) return undefined;
    return match[1].replace(/-\d+_\d+_\d+$/, "");
  }

  normalizeExporterMode(exporterMode) {
    const normalized = String(exporterMode).trim().toLowerCase();
    if (!["loki", "otlp", "both"].includes(normalized)) {
      throw new Error(
        `[Elven] Invalid exporter_mode '${exporterMode}'. Supported values: loki, otlp, both`
      );
    }

    return normalized;
  }

  getOtelLayerArn(runtime, region) {
    const release = LAYER_MANIFEST.versions[runtime];
    if (!release) {
      throw new Error(`[Elven] Runtime '${runtime}' is not supported.`);
    }

    return `arn:aws:lambda:${region}:${LAYER_MANIFEST.account}:layer:${release.name}:${release.version}`;
  }

  getLogLayerArn(architecture, region, logVersion, logVersionArm64) {
    const isArm64 = architecture === "arm64";
    const layerName = isArm64
      ? "elven-lambda-log-extension-arm64"
      : "elven-lambda-log-extension";
    const layerVersion = isArm64 ? logVersionArm64 : logVersion;

    return `arn:aws:lambda:${region}:911167927290:layer:${layerName}:${layerVersion}`;
  }

  buildEnvironmentVariables({
    collectorEndpoint,
    disabledInstrumentations,
    enabledInstrumentations,
    exporterMode,
    fullFunctionName,
    logsEndpoint,
    otlpHeaders,
    otlpLogsEndpoint,
    resourceAttributes,
    runtime,
    stage,
    tenant,
    token,
  }) {
    const otelResourceAttributes = this.buildResourceAttributes({
      fullFunctionName,
      resourceAttributes,
      stage,
      tenant,
    });

    const environmentVariables = {
      AWS_LAMBDA_EXEC_WRAPPER: "/opt/otel-handler",
      OTEL_SERVICE_NAME: fullFunctionName,
      OTEL_TRACES_SAMPLER: "parentbased_always_on",
      OTEL_LAMBDA_TRACE_MODE: "capture",
      OTEL_PROPAGATORS: "tracecontext,baggage,xray",
      OTEL_RESOURCE_ATTRIBUTES: otelResourceAttributes,
      OTEL_EXPORTER_OTLP_ENDPOINT: collectorEndpoint,
      EXPORTER_MODE: exporterMode,
      TENANT_ID: tenant,
      SERVICE_NAME: fullFunctionName,
      RESOURCES_ATTRIBUTES: `service=${fullFunctionName},environment=${stage}`,
      API_TOKEN: token,
      LOKI_URL: logsEndpoint,
      LOKI_TENANT_ID: tenant,
      LOKI_AUTH_TOKEN: token,
      DEBUG: "false",
    };

    if (otlpLogsEndpoint) {
      environmentVariables.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = otlpLogsEndpoint;
    }

    if (otlpHeaders) {
      environmentVariables.OTEL_EXPORTER_OTLP_HEADERS = otlpHeaders;
    }

    switch (runtime) {
      case "node":
        environmentVariables.OTEL_NODE_ENABLED_INSTRUMENTATIONS = enabledInstrumentations;
        if (disabledInstrumentations) {
          environmentVariables.OTEL_NODE_DISABLED_INSTRUMENTATIONS = disabledInstrumentations;
        }
        break;
      case "python":
        if (disabledInstrumentations) {
          environmentVariables.OTEL_PYTHON_DISABLED_INSTRUMENTATIONS = disabledInstrumentations;
        }
        break;
      case "ruby":
        if (disabledInstrumentations) {
          environmentVariables.OTEL_RUBY_DISABLED_INSTRUMENTATIONS = disabledInstrumentations;
        }
        break;
      case "javaagent":
      case "javawrapper":
        environmentVariables.OTEL_INSTRUMENTATION_COMMON_DEFAULT_ENABLED = "true";
        break;
      default:
        throw new Error(`[Elven] Runtime '${runtime}' is not supported.`);
    }

    return environmentVariables;
  }

  buildResourceAttributes({ fullFunctionName, resourceAttributes, stage, tenant }) {
    const extraAttributes = String(resourceAttributes || "").trim();
    const extraKeys = new Set(
      extraAttributes
        .split(",")
        .map((part) => part.trim().split("=")[0])
        .filter(Boolean)
    );

    const defaultAttributes = [
      ["service.name", fullFunctionName],
      ["environment", stage],
      ["tenant.id", tenant],
    ]
      .filter(([key, value]) => value !== undefined && value !== "" && !extraKeys.has(key))
      .map(([key, value]) => `${key}=${value}`);

    if (!extraAttributes) {
      return defaultAttributes.join(",");
    }

    return defaultAttributes.concat(extraAttributes).join(",");
  }

  warnAboutRuntimeConflict({ functionName, resolvedRuntime, serverlessRuntime }) {
    const serverlessRuntimeFamily = this.getServerlessRuntimeFamily(serverlessRuntime);
    if (!serverlessRuntimeFamily) {
      return;
    }

    const compatible =
      (serverlessRuntimeFamily === "java" &&
        (resolvedRuntime === "javaagent" || resolvedRuntime === "javawrapper")) ||
      serverlessRuntimeFamily === resolvedRuntime;

    if (!compatible) {
      this.serverless.cli.log(
        `⚠️  [Elven] Runtime mismatch for function '${functionName}': skipping incompatible Elven runtime '${resolvedRuntime}'.`
      );
    }
    return !compatible;
  }

  getServerlessRuntimeFamily(runtime) {
    if (typeof runtime !== "string") {
      return null;
    }

    const normalized = runtime.trim().toLowerCase();

    if (normalized.startsWith("nodejs")) {
      return "node";
    }

    if (normalized.startsWith("python")) {
      return "python";
    }

    if (normalized.startsWith("ruby")) {
      return "ruby";
    }

    if (normalized.startsWith("java")) {
      return "java";
    }

    return null;
  }
}

module.exports = ElvenLayerPlugin;
