const http = require("http");
const crypto = require("crypto");
const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { config, StepError } = require("./lib/config");
const tools = require("./lib/tools");

const INFO = { name: "ha_diag", version: require("./package.json").version };
const MAX_BODY_BYTES = 1024 * 1024;

// No MCP_TOKEN = everything refused.
function allowed(header) {
  if (!config.mcpToken) {
    return false;
  }

  const hash = (s) => crypto.createHash("sha256").update(String(s)).digest();
  return crypto.timingSafeEqual(hash(`Bearer ${config.mcpToken}`), hash(header || ""));
}

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function wrap(fn) {
  return async (args) => {
    try {
      return ok(await fn(args || {}));
    } catch (e) {
      if (!(e instanceof StepError)) {
        console.error(e);
      }

      return { content: [{ type: "text", text: e instanceof StepError ? e.message : "Unexpected error (see the MCP container log)" }], isError: true };
    }
  };
}

const READ_ONLY = { readOnlyHint: true };
const entity = z.string().min(1).describe("An entity ID, e.g. sensor.bedroom_temperature");

function registerTools(server) {
  const add = (name, title, description, inputSchema, fn) =>
    server.registerTool(name, { title, description, inputSchema, annotations: READ_ONLY }, wrap(fn));

  add(
    "ha_status",
    "Home Assistant status",
    "Version, state and safe mode, number of integrations and entities, unavailable entities, active repairs, system log counts by level, and every update entity with an update available (core, OS, add-ons such as Zigbee2MQTT, HACS items).",
    {},
    () => tools.haStatus(),
  );
  add(
    "system_log",
    "System log",
    "Home Assistant's grouped errors and warnings (Settings > System > Logs): logger, level, count, first and last time, source and message, newest first. Secret-looking values are hidden.",
    {
      level: z.string().optional().describe("ERROR, WARNING, CRITICAL, INFO or DEBUG"),
      contains: z.string().optional().describe("Only entries whose logger or message contains this"),
      limit: z.number().int().min(1).optional().describe("Default 30, at most 200"),
      exceptions: z.boolean().optional().describe("Include tracebacks"),
    },
    (a) => tools.systemLog(a),
  );
  add(
    "logs",
    "Raw logs",
    "The last lines of the raw log of Home Assistant core, the Supervisor, the host, or an add-on by slug (see list_addons), through the Supervisor. Secret-looking values are hidden; the filter can't catch everything, so don't repeat log content beyond what the task needs.",
    {
      source: z.string().min(1).describe("core, supervisor, host, or an add-on slug such as 45df7312_zigbee2mqtt"),
      lines: z.number().int().min(1).optional().describe(`Default 100, at most ${config.maxLogLines}`),
      contains: z.string().optional().describe("Only lines containing this (searches up to 5x more lines)"),
    },
    (a) => tools.logs(a),
  );
  add("list_addons", "List add-ons", "Installed add-ons: name, slug, state, installed and latest version, update available.", {}, () => tools.listAddons());
  add(
    "repairs",
    "Repairs",
    "Active repair issues (Settings > Repairs): domain, issue, severity, when created, whether it is fixable, and the HA version it breaks in.",
    { include_ignored: z.boolean().optional() },
    (a) => tools.repairs(a),
  );
  add(
    "list_states",
    "List states",
    "Current state of every entity, exposed to Assist or not, filtered by domain, text or state. Attributes only when asked (values under secret-looking keys, entity pictures and coordinates are hidden).",
    {
      domain: z.string().optional().describe("e.g. climate, update, sensor"),
      contains: z.string().optional().describe("Part of the entity ID or name"),
      state: z.string().optional().describe("Only this state, e.g. unavailable"),
      attributes: z.boolean().optional(),
      limit: z.number().int().min(1).optional().describe("Default 200, at most 2000"),
    },
    (a) => tools.listStates(a),
  );
  add(
    "get_entity",
    "Get an entity",
    "One entity: state, attributes, its entity registry entry (integration, unique ID, disabled or hidden) and its device (manufacturer, model, firmware, area).",
    { entity_id: entity },
    (a) => tools.getEntity(a),
  );
  add(
    "config_entries",
    "Config entries",
    "Integration config entries: domain, title, state (loaded, setup_error, …) and why. Never includes their data or options.",
    { domain: z.string().optional() },
    (a) => tools.configEntries(a),
  );
  add(
    "get_config",
    "Automation or script config",
    "The stored config of a UI-editable automation (automations.yaml) or script (scripts.yaml), triggers, conditions and actions, by entity ID. Secret-looking values are hidden.",
    { entity_id: entity.describe("automation.* or script.*") },
    (a) => tools.getConfig(a),
  );
  add(
    "find_usage",
    "Find usage",
    "What refers to an item, and what it refers to: automations, scripts, scenes, devices, entities, areas, blueprints (HA's own 'Related' search).",
    {
      item_type: z.enum(tools.ITEM_TYPES),
      item_id: z.string().min(1).describe("Entity ID, device ID, config entry ID, blueprint path, …"),
    },
    (a) => tools.findUsage(a),
  );
  add(
    "history",
    "History",
    "State changes of up to 5 entities over the last hours, without attributes.",
    {
      entity_id: z.string().min(1).describe("One entity ID, or up to 5 separated by commas"),
      hours: z.number().int().min(1).optional().describe("Default 24, at most 168"),
      limit: z.number().int().min(1).optional().describe("Latest changes per entity, default 200, at most 1000"),
    },
    (a) => tools.history(a),
  );
  add(
    "z2m_bridge",
    "Zigbee2MQTT bridge",
    "Zigbee2MQTT's retained bridge info: online state, version, herdsman versions, coordinator type and firmware, channel, restart required, and the Home Assistant, availability, OTA and advanced settings. Never includes the network key or MQTT login.",
    {},
    () => tools.z2mBridge(),
  );
  add(
    "z2m_devices",
    "Zigbee2MQTT devices",
    "Zigbee2MQTT's device list: name, IEEE address, type, model, vendor, power source, firmware, interview and support state. Optionally the exposed properties of each.",
    { contains: z.string().optional().describe("Part of the name, model, vendor or IEEE address"), exposes: z.boolean().optional() },
    (a) => tools.z2mDevices(a),
  );
}

function send(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const httpServer = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0].replace(/\/+$/, "") || "/";

  if (url === "/health") {
    return send(res, 200, { ok: true });
  }

  if (url !== "/mcp" && url !== "/") {
    return send(res, 404, { error: "not found" });
  }

  if (!allowed(req.headers.authorization)) {
    return send(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  }

  const chunks = [];
  let size = 0;

  try {
    for await (const chunk of req) {
      size += chunk.length;

      if (size > MAX_BODY_BYTES) {
        res.setHeader("Connection", "close");
        return send(res, 413, { jsonrpc: "2.0", error: { code: -32600, message: "Request body too large" }, id: null });
      }

      chunks.push(chunk);
    }
  } catch {
    return; // The client went away mid-request.
  }

  let body;

  try {
    body = size ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : undefined;
  } catch {
    return send(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  }

  // Stateless Streamable HTTP: a fresh server and transport per request.
  const server = new McpServer(INFO);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    registerTools(server);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    console.error(e);

    if (!res.headersSent) {
      send(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

if (require.main === module) {
  httpServer.listen(config.port, () => {
    console.log(`${INFO.name} MCP ${INFO.version} on :${config.port}/mcp`);

    if (!config.mcpToken) {
      console.log("MCP_TOKEN is not set: every /mcp request is refused (401).");
    }
  });
}

module.exports = { httpServer, registerTools };
