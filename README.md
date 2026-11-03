# ha-diag MCP

Read-only MCP server (Streamable HTTP, stateless, `POST /mcp`) for diagnosing Home Assistant: logs, repairs, states, config entries, automation and script config, and Zigbee2MQTT's bridge info. It has no write tools: it only sends HTTP GETs and read-only websocket commands.

Home Assistant's own MCP server (`/api/mcp`) only sees entities exposed to Assist. This one covers what that can't: errors, repairs, add-on logs, every entity, and what refers to what.

## Tools

| Tool | Reads |
|---|---|
| `ha_status` | version, state, entity and repair counts, system log counts, update entities with an update |
| `system_log` | grouped errors and warnings (websocket `system_log/list`) |
| `logs` | raw log of `core`, `supervisor`, `host` or an add-on slug, through the Supervisor proxy |
| `list_addons` | add-ons with versions and update state (websocket `supervisor/api`, GET `/addons` only) |
| `repairs` | repair issues (websocket `repairs/list_issues`) |
| `list_states`, `get_entity` | states, attributes on request, entity and device registry entries |
| `config_entries` | integration entries: domain, title, state, reason (never data or options) |
| `get_config` | stored config of a UI-editable automation or script |
| `find_usage` | HA's "Related" search (websocket `search/related`) |
| `history` | state changes of up to 5 entities, at most 7 days |
| `z2m_bridge`, `z2m_devices` | Zigbee2MQTT's retained `bridge/info`, `bridge/state` and `bridge/devices` (websocket `mqtt/subscribe`) |

Every tool picks named fields. Values under secret-looking keys (passwords, tokens, keys, the Zigbee network key, entity pictures, coordinates) and secret shapes inside strings are hidden. The filter can't catch everything, so treat log output with care.

## Container

Image: `ghcr.io/drakknar/ha-diag-mcp`, port 8080.

| Setting | Value |
|---|---|
| `MCP_TOKEN` | required: without it every request gets 401 |
| `HA_URL` | required: Home Assistant's base URL, e.g. `http://192.168.1.2` |
| `HA_TOKEN` | required: long-lived token of a dedicated **administrator** user. Logs, repairs, the Supervisor proxy and MQTT subscribe are admin-only in HA. Revoke it on its own if needed |
| `Z2M_BASE_TOPIC` | optional, default `zigbee2mqtt` |
| `TIMEOUT_MS`, `MQTT_WAIT_MS`, `MAX_LOG_LINES` | optional: 15000, 5000, 500 |

## Tests

`node test/tools.test.js` (Node 20+): fake Home Assistant (REST and websocket), real MCP client. The test fails if any tool leaks a planted secret or sends anything but GETs and the allow-listed websocket commands.
