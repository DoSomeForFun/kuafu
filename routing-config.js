import { telemetry } from "./telemetry.js";

const ROUTER_ENV_SOURCES = {
  model: [
    { name: "KUAFU_ROUTER_MODEL", state: "current" },
    { name: "AGENT_ROUTING_MODEL", state: "legacy", removeAfter: "2026-10-31", replacement: "KUAFU_ROUTER_MODEL" },
    { name: "AGENT_ROUTER_MODEL", state: "legacy", removeAfter: "2026-09-30", replacement: "KUAFU_ROUTER_MODEL" },
    { name: "TELEGRAM_ROUTER_MODEL", state: "legacy", removeAfter: "2026-08-31", replacement: "KUAFU_ROUTER_MODEL" }
  ],
  endpoint: [
    { name: "KUAFU_ROUTER_BASE_URL", state: "current" },
    { name: "AGENT_ROUTING_BASE_URL", state: "legacy", removeAfter: "2026-10-31", replacement: "KUAFU_ROUTER_BASE_URL" },
    { name: "AGENT_ROUTER_BASE_URL", state: "legacy", removeAfter: "2026-09-30", replacement: "KUAFU_ROUTER_BASE_URL" },
    { name: "TELEGRAM_ROUTER_BASE_URL", state: "legacy", removeAfter: "2026-08-31", replacement: "KUAFU_ROUTER_BASE_URL" },
    { name: "OPENAI_COMPAT_BASE_URL", state: "fallback" }
  ],
  apiKey: [
    { name: "KUAFU_ROUTER_API_KEY", state: "current" },
    { name: "AGENT_ROUTING_API_KEY", state: "legacy", removeAfter: "2026-10-31", replacement: "KUAFU_ROUTER_API_KEY" },
    { name: "AGENT_ROUTER_API_KEY", state: "legacy", removeAfter: "2026-09-30", replacement: "KUAFU_ROUTER_API_KEY" },
    { name: "TELEGRAM_ROUTER_API_KEY", state: "legacy", removeAfter: "2026-08-31", replacement: "KUAFU_ROUTER_API_KEY" },
    { name: "OPENAI_COMPAT_API_KEY", state: "fallback" }
  ]
};

const warnedLegacyEnv = new Set();

function readEnvValue(name, env) {
  const value = env[name];
  if (value == null) return "";
  const s = String(value).trim();
  if (!s || s === "undefined") return "";
  return s;
}

function warnLegacyOnce(source, field) {
  if (!source || source.state !== "legacy") return;
  const key = `${field}:${source.name}`;
  if (warnedLegacyEnv.has(key)) return;
  warnedLegacyEnv.add(key);
  telemetry.warn("[RoutingConfig] Legacy router env is deprecated", {
    field,
    env: source.name,
    replacement: source.replacement,
    removeAfter: source.removeAfter
  });
}

function resolveField(field, env) {
  const sources = ROUTER_ENV_SOURCES[field] || [];
  for (const source of sources) {
    const value = readEnvValue(source.name, env);
    if (!value) continue;
    warnLegacyOnce(source, field);
    return { value, source: source.name };
  }
  return { value: "", source: "" };
}

export function getRoutingModelConfig(env = process.env) {
  const model = resolveField("model", env);
  const endpoint = resolveField("endpoint", env);
  const apiKey = resolveField("apiKey", env);

  const config = {
    model: model.value,
    endpoint: endpoint.value,
    apiKey: apiKey.value,
    source: {
      model: model.source,
      endpoint: endpoint.source,
      apiKey: apiKey.source
    }
  };

  Object.keys(config).forEach((key) => {
    if (key === "source") return;
    if (!config[key] || config[key] === "undefined") delete config[key];
  });
  return config;
}

export function getRoutingEnvSources() {
  return ROUTER_ENV_SOURCES;
}
