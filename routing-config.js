export function getRoutingModelConfig() {
  const config = {
    model: process.env.AGENT_ROUTING_MODEL || process.env.AGENT_ROUTER_MODEL || process.env.TELEGRAM_ROUTER_MODEL,
    endpoint: process.env.AGENT_ROUTING_BASE_URL || process.env.AGENT_ROUTER_BASE_URL || process.env.TELEGRAM_ROUTER_BASE_URL || process.env.OPENAI_COMPAT_BASE_URL,
    apiKey: process.env.AGENT_ROUTING_API_KEY || process.env.AGENT_ROUTER_API_KEY || process.env.TELEGRAM_ROUTER_API_KEY || process.env.OPENAI_COMPAT_API_KEY
  };

  Object.keys(config).forEach((key) => {
    if (!config[key] || config[key] === "undefined") delete config[key];
  });
  return config;
}
