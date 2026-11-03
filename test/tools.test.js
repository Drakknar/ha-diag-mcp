// Test of ha-diag-mcp: fake Home Assistant (REST + websocket), real MCP client.
// Run with Node 20+: node test/tools.test.js
const assert = require("assert");
const http = require("http");
const { WebSocketServer } = require("ws");

const FAKE = "fake-value-that-must-not-appear";
const TOKEN = "ha-test-token";
const calls = [];
const methods = new Set();

const STATES = [
  { entity_id: "update.zigbee2mqtt_update", state: "on", attributes: { title: "Zigbee2MQTT", installed_version: "2.14.2", latest_version: "2.14.3" }, last_changed: "t" },
  { entity_id: "update.home_assistant_core_update", state: "off", attributes: { title: "Core", installed_version: "2026.10.4", latest_version: "2026.10.4" }, last_changed: "t" },
  { entity_id: "sensor.bedroom_w100_action", state: "single", attributes: { friendly_name: "Bedroom W100 action" }, last_changed: "t" },
  { entity_id: "camera.door", state: "idle", attributes: { friendly_name: "Door", access_token: FAKE, entity_picture: `/api/camera_proxy/camera.door?token=${FAKE}` }, last_changed: "t" },
  { entity_id: "person.me", state: "home", attributes: { friendly_name: "Me", latitude: 52.5, longitude: 13.4 }, last_changed: "t" },
  { entity_id: "automation.heat", state: "on", attributes: { friendly_name: "Heat", id: "171" }, last_changed: "t" },
  { entity_id: "automation.yaml_only", state: "on", attributes: { friendly_name: "Y" }, last_changed: "t" },
  { entity_id: "light.dead", state: "unavailable", attributes: {}, last_changed: "t" },
];

const ROUTES = {
  "/api/config": { version: "2026.10.4", state: "RUNNING", safe_mode: false, components: ["mqtt", "zha"], latitude: 52.5, longitude: 13.4, location_name: "Home", allowlist_external_dirs: ["/x"] },
  "/api/states": STATES,
  "/api/config/automation/config/171": { id: "171", alias: "Heat", triggers: [{ trigger: "state", entity_id: "sensor.bedroom_w100_action" }], actions: [{ action: "rest_command.x", data: { password: FAKE, url: `https://u:${FAKE}@h/x` } }] },
  "/api/config/script/config/morning": { alias: "Morning", sequence: [] },
};

const BRIDGE_INFO = {
  version: "2.14.3", commit: "abc", zigbee_herdsman: { version: "11.0.0" }, coordinator: { type: "EmberZNet", ieee_address: "0x00124b0000000001", meta: { revision: "8.0.2" } },
  network: { channel: 15, pan_id: 1234, extended_pan_id: "0xdd", network_key: [1, 2, 3] }, log_level: "info", permit_join: false, restart_required: false,
  config: { homeassistant: { enabled: true, legacy_action_sensor: true }, mqtt: { server: "mqtt://core-mosquitto", user: "addons", password: FAKE }, advanced: { network_key: [9, 9], pan_id: 6754, last_seen: "ISO_8601", log_level: "info" }, serial: { port: "/dev/ttyUSB0", adapter: "ember" }, frontend: { enabled: true, auth_token: FAKE } },
};
const DEVICES = [
  { friendly_name: "Coordinator", ieee_address: "0x00124b0000000001", type: "Coordinator", interview_completed: true, supported: false },
  { friendly_name: "Bedroom TRV 1", ieee_address: "0xa4c1380000000001", type: "EndDevice", model_id: "TRVZB", manufacturer: "SONOFF", power_source: "Battery", software_build_id: "1.4.4",
    interview_state: "SUCCESSFUL", supported: true, definition: { model: "TRVZB", vendor: "SONOFF", description: "Thermostatic radiator valve", exposes: [{ type: "climate", features: [{ property: "occupied_heating_setpoint", type: "numeric", access: 7 }] }, { property: "battery", type: "numeric", access: 1 }] } },
];

const authorized = (req) => req.headers.authorization === `Bearer ${TOKEN}`;

const ha = http.createServer((req, res) => {
  calls.push(`${req.method} ${req.url}`);
  methods.add(req.method);
  const path = req.url.split("?")[0];

  if (!authorized(req)) {
    res.writeHead(401);
    return res.end();
  }

  if (path === "/api/hassio/core/logs/latest") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end(`line one\nERROR (MainThread) [homeassistant.components.mqtt] bad Bearer ${FAKE}xyz\nToken: ${FAKE}\nlast line\n`);
  }

  if (path === "/api/hassio/addons/45df7312_zigbee2mqtt/logs/latest") {
    res.writeHead(404);
    return res.end();
  }

  if (path === "/api/hassio/addons/45df7312_zigbee2mqtt/logs") {
    assert.strictEqual(req.headers.range, "entries=:-500:");
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("[z2m] info: started\n[z2m] warning: legacy_action_sensor is deprecated\n");
  }

  if (path.startsWith("/api/history/period/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify([[{ entity_id: "light.dead", state: "on", last_changed: "a" }, { state: "unavailable", last_changed: "b" }]]));
  }

  if (path.startsWith("/api/states/")) {
    const s = STATES.find((x) => x.entity_id === path.slice(12));
    res.writeHead(s ? 200 : 404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(s || {}));
  }

  const body = ROUTES[path];
  res.writeHead(body ? 200 : 404, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body || { message: "not found" }));
});

const WS = {
  "repairs/list_issues": { issues: [{ domain: "mqtt", issue_id: "x", severity: "warning", ignored: false, translation_placeholders: { url: `http://u:${FAKE}@h/` }, data: { secret: FAKE } }, { domain: "old", issue_id: "y", ignored: true }] },
  "system_log/list": [
    { name: "homeassistant.components.mqtt", level: "ERROR", count: 3, timestamp: 2000, first_occurred: 1000, source: ["mqtt/x.py", 10], message: [`failed api_key=${FAKE}`], exception: "Traceback" },
    { name: "custom_components.versatile_thermostat", level: "WARNING", count: 1, timestamp: 3000, source: ["vt.py", 1], message: ["slow"] },
  ],
  "supervisor/api": { addons: [{ name: "Zigbee2MQTT", slug: "45df7312_zigbee2mqtt", state: "started", version: "2.14.2", version_latest: "2.14.3", update_available: true, options: { secret: FAKE } }] },
  "config/entity_registry/get": { platform: "mqtt", device_id: "dev1", unique_id: "0xa4c_action", options: { secret: FAKE } },
  "config/device_registry/list": [{ id: "dev1", name: "Bedroom W100", manufacturer: "Aqara", model: "W100", sw_version: "1641", identifiers: [["mqtt", FAKE]] }],
  "config_entries/get": [{ entry_id: "e1", domain: "mqtt", title: "Mosquitto", state: "loaded", data: { password: FAKE }, options: {} }],
  "search/related": { automation: ["automation.heat"], device: ["dev1"] },
};

const wss = new WebSocketServer({ server: ha, path: "/api/websocket" });
wss.on("connection", (sock) => {
  let authed = false;
  sock.send(JSON.stringify({ type: "auth_required" }));
  sock.on("message", (raw) => {
    const m = JSON.parse(raw);

    if (m.type === "auth") {
      authed = m.access_token === TOKEN;
      return sock.send(JSON.stringify({ type: authed ? "auth_ok" : "auth_invalid" }));
    }

    assert(authed, "command before auth");
    calls.push(`ws ${m.type}${m.endpoint ? ` ${m.method} ${m.endpoint}` : ""}${m.topic ? ` ${m.topic}` : ""}`);

    if (m.type === "unsubscribe_events") {
      return sock.send(JSON.stringify({ id: m.id, type: "result", success: true, result: null }));
    }

    if (m.type === "mqtt/subscribe") {
      sock.send(JSON.stringify({ id: m.id, type: "result", success: true, result: null }));
      const payload = { "zigbee2mqtt/bridge/info": BRIDGE_INFO, "zigbee2mqtt/bridge/devices": DEVICES, "zigbee2mqtt/bridge/state": { state: "online" } }[m.topic];

      if (payload) {
        sock.send(JSON.stringify([{ id: m.id, type: "event", event: { topic: m.topic, payload: JSON.stringify(payload), retain: true } }]));
      }

      return;
    }

    if (m.type === "supervisor/api") {
      assert.strictEqual(m.method, "get", "Supervisor calls must be GET");
    }

    const result = WS[m.type];
    sock.send(JSON.stringify(result === undefined ? { id: m.id, type: "result", success: false, error: { code: "unknown_command", message: m.type } } : { id: m.id, type: "result", success: true, result }));
  });
});

(async () => {
  await new Promise((r) => ha.listen(0, "127.0.0.1", r));
  Object.assign(process.env, { HA_URL: `http://127.0.0.1:${ha.address().port}`, HA_TOKEN: TOKEN, MCP_TOKEN: "tok", PORT: "0", MQTT_WAIT_MS: "300" });

  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { httpServer } = require("../server");
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${httpServer.address().port}/mcp`;

  // No token, wrong token: refused.
  for (const auth of [undefined, "Bearer nope"]) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: "{}" });
    assert.strictEqual(r.status, 401);
  }

  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: "Bearer tok" } } }));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content[0].text;
    assert(!text.includes(FAKE), `${name} leaked a secret: ${text}`);
    return r.isError ? { error: text } : JSON.parse(text);
  };

  const tools = (await client.listTools()).tools;
  assert(tools.every((t) => t.annotations?.readOnlyHint), "every tool is read-only");
  assert.strictEqual(tools.length, 13);

  const status = await call("ha_status");
  assert.strictEqual(status.version, "2026.10.4");
  assert.strictEqual(status.repairs, 1);
  assert.strictEqual(status.unavailable, 1);
  assert.deepStrictEqual(status.system_log, { ERROR: 3, WARNING: 1 });
  assert.deepStrictEqual(status.updates_available.map((u) => u.latest), ["2.14.3"]);
  assert(!("latitude" in status) && !("location_name" in status) && !("allowlist_external_dirs" in status));

  const log = await call("system_log", { level: "error", exceptions: true });
  assert.strictEqual(log.entries.length, 1);
  assert.strictEqual(log.entries[0].source, "mqtt/x.py:10");
  assert.strictEqual(log.entries[0].exception, "Traceback");
  assert.strictEqual((await call("system_log", { contains: "versatile" })).entries[0].level, "WARNING");

  const core = await call("logs", { source: "core", lines: 2 });
  assert.strictEqual(core.lines, 2);
  assert(core.log.endsWith("last line"));
  const z2mLog = await call("logs", { source: "45df7312_zigbee2mqtt", contains: "deprecated" });
  assert.strictEqual(z2mLog.lines, 1);
  assert((await call("logs", { source: "../etc" })).error.startsWith("Not a log source"));

  assert.strictEqual((await call("list_addons")).addons[0].version_latest, "2.14.3");
  assert(!JSON.stringify(await call("list_addons")).includes("options"));

  const rep = await call("repairs");
  assert.strictEqual(rep.issues.length, 1);
  assert(!("data" in rep.issues[0]));
  assert.strictEqual((await call("repairs", { include_ignored: true })).issues.length, 2);

  const st = await call("list_states", { domain: "camera", attributes: true });
  assert.strictEqual(st.states[0].attributes.entity_picture, "[hidden]");
  assert.strictEqual((await call("list_states", { domain: "person", attributes: true })).states[0].attributes.latitude, "[hidden]");
  assert.strictEqual((await call("list_states", { state: "unavailable" })).matched, 1);
  assert.strictEqual((await call("list_states", { contains: "w100" })).states[0].attributes, undefined);

  const ent = await call("get_entity", { entity_id: "sensor.bedroom_w100_action" });
  assert.strictEqual(ent.registry.platform, "mqtt");
  assert.strictEqual(ent.device.model, "W100");
  assert(!("options" in ent.registry) && !("identifiers" in ent.device));
  assert((await call("get_entity", { entity_id: "x; rm" })).error.startsWith("Not an entity ID"));

  const ce = await call("config_entries", { domain: "mqtt" });
  assert.strictEqual(ce.entries[0].state, "loaded");
  assert(!("data" in ce.entries[0]));

  const auto = await call("get_config", { entity_id: "automation.heat" });
  assert.strictEqual(auto.config.triggers[0].entity_id, "sensor.bedroom_w100_action");
  assert.strictEqual(auto.config.actions[0].data.password, "[hidden]");
  assert((await call("get_config", { entity_id: "automation.yaml_only" })).error.includes("no id attribute"));
  assert.strictEqual((await call("get_config", { entity_id: "script.morning" })).config.alias, "Morning");
  assert((await call("get_config", { entity_id: "light.dead" })).error.startsWith("Only automation"));

  assert.deepStrictEqual((await call("find_usage", { item_type: "entity", item_id: "sensor.bedroom_w100_action" })).related.automation, ["automation.heat"]);

  const hist = await call("history", { entity_id: "light.dead", hours: 2 });
  assert.deepStrictEqual(hist.entities[0].states.map((s) => s.state), ["on", "unavailable"]);

  const bridge = await call("z2m_bridge");
  assert.strictEqual(bridge.state, "online");
  assert.strictEqual(bridge.version, "2.14.3");
  assert.strictEqual(bridge.config.homeassistant.legacy_action_sensor, true);
  assert.strictEqual(bridge.network.channel, 15);
  const bridgeText = JSON.stringify(bridge);
  for (const gone of ["network_key", "pan_id", "mqtt", "password", "auth_token", "/dev/ttyUSB0"]) {
    assert(!bridgeText.includes(gone), `z2m_bridge shows ${gone}`);
  }

  const dev = await call("z2m_devices", { contains: "trvzb", exposes: true });
  assert.strictEqual(dev.total, 2);
  assert.strictEqual(dev.devices[0].software_build_id, "1.4.4");
  assert.deepStrictEqual(dev.devices[0].exposes.map((e) => e.property), ["occupied_heating_setpoint", "battery"]);

  // Nothing but reads reached Home Assistant.
  assert.deepStrictEqual([...methods], ["GET"]);
  for (const c of calls.filter((c) => c.startsWith("ws "))) {
    assert(/^ws (repairs\/list_issues|system_log\/list|supervisor\/api get \/addons|config\/entity_registry\/get|config\/device_registry\/list|config_entries\/get|search\/related|mqtt\/subscribe \S+|unsubscribe_events)$/.test(c), `unexpected websocket call: ${c}`);
  }

  // A wrong HA token is reported, not crashed on.
  process.env.HA_TOKEN = "wrong";
  require("../lib/config").config.haToken = "wrong";
  assert((await call("ha_status")).error.includes("refused the token"));
  assert((await call("repairs")).error.includes("refused the token"));

  await client.close();
  httpServer.close();
  wss.close();
  ha.close();
  console.log("OK");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
