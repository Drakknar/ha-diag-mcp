// All settings come from the container's environment.
const env = process.env;

// No built-in addresses: a setting this server can't work without stops it at start-up.
function required(name) {
  if (!env[name]) {
    throw new Error(`Environment variable ${name} is required`);
  }

  return env[name];
}

const config = {
  port: Number(env.PORT || 8080),
  mcpToken: env.MCP_TOKEN || "",

  haUrl: required("HA_URL").replace(/\/+$/, ""),
  // A long-lived token of a dedicated HA administrator: logs, repairs and the Supervisor proxy are admin-only.
  haToken: required("HA_TOKEN"),
  z2mBaseTopic: (env.Z2M_BASE_TOPIC || "zigbee2mqtt").replace(/\/+$/, ""),

  timeoutMs: Number(env.TIMEOUT_MS || 15000),
  // How long to wait for a retained MQTT message before saying there is none.
  mqttWaitMs: Number(env.MQTT_WAIT_MS || 5000),
  maxLogLines: Number(env.MAX_LOG_LINES || 500),
};

class StepError extends Error {}

module.exports = { config, StepError };
