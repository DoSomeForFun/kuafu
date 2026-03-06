/**
 * Routing model configuration reader.
 * Reads from well-known environment variable names (in priority order).
 */

export type RoutingModelConfig = {
  model?: string;
  endpoint?: string;
  apiKey?: string;
};

function pickFirst(candidates: Array<string | undefined>): string | undefined {
  for (const v of candidates) {
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

export function getRoutingModelConfig(env: Record<string, string | undefined>): RoutingModelConfig {
  return {
    model: pickFirst([
      env['KUAFU_ROUTER_MODEL'],
      env['AGENT_ROUTING_MODEL'],
      env['AGENT_ROUTER_MODEL'],
      env['TELEGRAM_ROUTER_MODEL'],
    ]),
    endpoint: pickFirst([
      env['KUAFU_ROUTER_BASE_URL'],
      env['AGENT_ROUTING_BASE_URL'],
      env['AGENT_ROUTER_BASE_URL'],
      env['TELEGRAM_ROUTER_BASE_URL'],
      env['OPENAI_COMPAT_BASE_URL'],
    ]),
    apiKey: pickFirst([
      env['KUAFU_ROUTER_API_KEY'],
      env['AGENT_ROUTING_API_KEY'],
      env['AGENT_ROUTER_API_KEY'],
      env['TELEGRAM_ROUTER_API_KEY'],
      env['OPENAI_COMPAT_API_KEY'],
    ]),
  };
}
