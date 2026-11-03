// Each function reads named fields only and returns plain data for one tool. Nothing here writes to Home Assistant.
const { config, StepError } = require("./config");
const { get, session, ws } = require("./ha");
const { redact, redactDeep } = require("./redact");

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));
const clamp = (n, dflt, max) => Math.min(Math.max(1, Number(n) || dflt), max);
const cut = (s, max) => (s && s.length > max ? `${s.slice(0, max)} [… ${s.length - max} more characters]` : s);
const has = (text, part) => !part || String(text ?? "").toLowerCase().includes(part.toLowerCase());

const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const SLUG = /^[a-z0-9_-]{1,64}$/;

function entityId(id) {
  const v = String(id || "").trim().toLowerCase();

  if (!ENTITY_ID.test(v)) {
    throw new StepError(`Not an entity ID: ${id}`);
  }

  return v;
}

const updateInfo = (s) => ({
  entity_id: s.entity_id,
  title: s.attributes?.title || s.attributes?.friendly_name,
  installed: s.attributes?.installed_version,
  latest: s.attributes?.latest_version,
  in_progress: s.attributes?.in_progress || undefined,
});

async function haStatus() {
  const cfg = await get("/api/config", { what: "configuration" });
  const states = await get("/api/states", { what: "states" });
  const [issues, log] = await session(async ({ call }) => [await call({ type: "repairs/list_issues" }), await call({ type: "system_log/list" })]);
  const active = (issues?.issues || []).filter((i) => !i.ignored);
  const levels = {};

  for (const e of log || []) {
    levels[e.level] = (levels[e.level] || 0) + (e.count || 1);
  }

  return {
    ...pick(cfg, ["version", "state", "safe_mode", "recovery_mode", "config_source", "time_zone", "country", "language"]),
    components: cfg.components?.length,
    entities: states.length,
    unavailable: states.filter((s) => s.state === "unavailable").length,
    repairs: active.length,
    system_log: levels,
    updates_available: states.filter((s) => s.entity_id.startsWith("update.") && s.state === "on").map(updateInfo),
  };
}

async function systemLog({ level, contains, limit, exceptions }) {
  const entries = (await ws({ type: "system_log/list" })) || [];
  const wanted = level ? level.toUpperCase() : null;
  const rows = entries
    .filter((e) => (!wanted || e.level === wanted) && (has(e.name, contains) || has([].concat(e.message).join(" "), contains)))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, clamp(limit, 30, 200))
    .map((e) => ({
      logger: e.name,
      level: e.level,
      count: e.count,
      first: e.first_occurred && new Date(e.first_occurred * 1000).toISOString(),
      last: e.timestamp && new Date(e.timestamp * 1000).toISOString(),
      source: Array.isArray(e.source) ? e.source.join(":") : e.source,
      message: cut(redact([].concat(e.message).join("\n")), 1000),
      exception: exceptions && e.exception ? cut(redact(e.exception), 3000) : undefined,
    }));

  return { total: entries.length, shown: rows.length, entries: rows };
}

// core, supervisor, host or an add-on slug. Journal lines through HA's Supervisor proxy.
async function logs({ source, lines, contains }) {
  const src = String(source || "core").trim().toLowerCase();

  if (!SLUG.test(src)) {
    throw new StepError(`Not a log source: ${source}`);
  }

  const n = clamp(lines, 100, config.maxLogLines);
  const want = contains ? Math.min(n * 5, config.maxLogLines * 5) : n;
  const base = ["core", "supervisor", "host"].includes(src) ? `/api/hassio/${src}/logs` : `/api/hassio/addons/${src}/logs`;
  let text;

  try {
    text = await get(`${base}/latest?lines=${want}`, { text: true, what: `logs of ${src}` });
  } catch (e) {
    if (!/\b(400|404)\b/.test(e.message)) {
      throw e;
    }

    text = await get(base, { text: true, headers: { Range: `entries=:-${want}:` }, what: `logs of ${src}` });
  }

  const all = redact(text).split("\n").filter((l) => l.trim());
  const rows = all.filter((l) => has(l, contains)).slice(-n);

  return { source: src, lines: rows.length, log: rows.join("\n") };
}

async function listAddons() {
  const r = await ws({ type: "supervisor/api", endpoint: "/addons", method: "get" });
  const addons = r?.addons || r?.data?.addons || [];

  return {
    addons: addons.map((a) => pick(a, ["name", "slug", "state", "version", "version_latest", "update_available", "repository"])),
  };
}

async function repairs({ include_ignored: all }) {
  const r = await ws({ type: "repairs/list_issues" });

  return {
    issues: (r?.issues || [])
      .filter((i) => all || !i.ignored)
      .map((i) =>
        redactDeep(
          pick(i, ["domain", "issue_id", "severity", "translation_key", "translation_placeholders", "created", "is_fixable", "ignored", "breaks_in_ha_version", "learn_more_url", "issue_domain"]),
        ),
      ),
  };
}

async function listStates({ domain, contains, state, attributes, limit }) {
  const all = await get("/api/states", { what: "states" });
  const max = clamp(limit, 200, 2000);
  const rows = all.filter(
    (s) =>
      (!domain || s.entity_id.startsWith(`${domain.toLowerCase()}.`)) &&
      (!state || s.state === state) &&
      (has(s.entity_id, contains) || has(s.attributes?.friendly_name, contains)),
  );

  return {
    matched: rows.length,
    shown: Math.min(rows.length, max),
    states: rows.slice(0, max).map((s) => ({
      entity_id: s.entity_id,
      state: redact(s.state),
      name: s.attributes?.friendly_name,
      last_changed: s.last_changed,
      attributes: attributes ? redactDeep(s.attributes) : undefined,
    })),
  };
}

async function getEntity({ entity_id: raw }) {
  const id = entityId(raw);
  const s = await get(`/api/states/${id}`, { what: `entity ${id}` });
  const [entry, devices] = await session(async ({ call }) => {
    let e = null;

    try {
      e = await call({ type: "config/entity_registry/get", entity_id: id });
    } catch {
      // Entities without a unique ID aren't in the registry.
    }

    return [e, e?.device_id ? await call({ type: "config/device_registry/list" }) : []];
  });
  const device = devices.find((d) => d.id === entry?.device_id);

  return {
    entity_id: s.entity_id,
    state: redact(s.state),
    last_changed: s.last_changed,
    last_updated: s.last_updated,
    attributes: redactDeep(s.attributes),
    registry: entry
      ? pick(entry, ["platform", "name", "original_name", "translation_key", "unique_id", "device_id", "area_id", "config_entry_id", "disabled_by", "hidden_by", "entity_category", "labels", "categories"])
      : null,
    device: device ? pick(device, ["id", "name", "name_by_user", "manufacturer", "model", "model_id", "sw_version", "hw_version", "area_id", "via_device_id", "disabled_by"]) : null,
  };
}

async function configEntries({ domain }) {
  const entries = await ws({ type: "config_entries/get", ...(domain ? { domain: domain.toLowerCase() } : {}) });

  return {
    entries: (entries || []).map((e) => pick(e, ["entry_id", "domain", "title", "state", "reason", "source", "disabled_by", "supports_options", "error_reason_translation_key"])),
  };
}

// The stored config of a UI-editable automation or script, as the automation editor sees it.
async function getConfig({ entity_id: raw }) {
  const id = entityId(raw);
  const [domain, objectId] = id.split(".");

  if (domain === "automation") {
    const s = await get(`/api/states/${id}`, { what: `entity ${id}` });
    const key = s.attributes?.id;

    if (!key) {
      throw new StepError(`${id} has no id attribute: it isn't defined in automations.yaml, so the automation editor can't show it`);
    }

    return { entity_id: id, config: redactDeep(await get(`/api/config/automation/config/${encodeURIComponent(key)}`, { what: `automation config ${key}` })) };
  }

  if (domain === "script") {
    return { entity_id: id, config: redactDeep(await get(`/api/config/script/config/${encodeURIComponent(objectId)}`, { what: `script config ${objectId} (not in scripts.yaml?)` })) };
  }

  throw new StepError("Only automation.* and script.* have a stored config here");
}

const ITEM_TYPES = ["entity", "device", "area", "floor", "label", "automation", "script", "scene", "group", "config_entry", "integration", "automation_blueprint", "script_blueprint"];

async function findUsage({ item_type: type, item_id: item }) {
  if (!ITEM_TYPES.includes(type)) {
    throw new StepError(`item_type must be one of ${ITEM_TYPES.join(", ")}`);
  }

  return { item_type: type, item_id: item, related: (await ws({ type: "search/related", item_type: type, item_id: String(item) })) || {} };
}

async function history({ entity_id: raw, hours, limit }) {
  const ids = String(raw || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 5)
    .map(entityId);

  if (!ids.length) {
    throw new StepError("entity_id is required");
  }

  const end = new Date();
  const start = new Date(end - clamp(hours, 24, 168) * 3600 * 1000);
  const q = new URLSearchParams({ filter_entity_id: ids.join(","), end_time: end.toISOString(), minimal_response: "", no_attributes: "" });
  const data = await get(`/api/history/period/${start.toISOString()}?${q}`, { what: "history" });
  const max = clamp(limit, 200, 1000);

  return {
    from: start.toISOString(),
    to: end.toISOString(),
    entities: (data || []).map((rows) => ({
      entity_id: rows[0]?.entity_id,
      changes: rows.length,
      states: rows.slice(-max).map((r) => ({ state: redact(r.state), at: r.last_changed || r.lu })),
    })),
  };
}

// Retained messages on Zigbee2MQTT's bridge topics, read through HA's MQTT integration.
async function retained(topics) {
  return session(async ({ firstEvent }) => {
    const out = {};

    for (const t of topics) {
      const ev = await firstEvent({ type: "mqtt/subscribe", topic: `${config.z2mBaseTopic}/${t}` }, config.mqttWaitMs);

      try {
        out[t] = ev ? JSON.parse(ev.payload) : null;
      } catch {
        out[t] = ev ? String(ev.payload) : null;
      }
    }

    return out;
  });
}

const ADVANCED = ["log_level", "log_output", "last_seen", "cache_state", "cache_state_persistent", "output", "elapsed", "channel", "transmit_power", "adapter_concurrent", "adapter_delay", "timestamp_format"];

async function z2mBridge() {
  const { "bridge/info": info, "bridge/state": state } = await retained(["bridge/info", "bridge/state"]);

  if (!info) {
    throw new StepError(`No retained message on ${config.z2mBaseTopic}/bridge/info: is Zigbee2MQTT running, and is the base topic right?`);
  }

  const c = info.config || {};

  return redactDeep({
    state: typeof state === "object" ? state?.state : state,
    ...pick(info, ["version", "commit", "zigbee_herdsman", "zigbee_herdsman_converters", "log_level", "permit_join", "permit_join_end", "restart_required"]),
    coordinator: pick(info.coordinator, ["type", "ieee_address", "meta"]),
    network: pick(info.network, ["channel"]),
    config: {
      homeassistant: c.homeassistant,
      availability: c.availability,
      ota: c.ota,
      device_options: c.device_options,
      serial: pick(c.serial, ["adapter", "baudrate", "rtscts"]),
      advanced: pick(c.advanced, ADVANCED),
      frontend: c.frontend ? { enabled: c.frontend.enabled !== false } : undefined,
    },
  });
}

const exposeNames = (list, out = []) => {
  for (const e of list || []) {
    if (e.property) {
      out.push({ property: e.property, type: e.type, access: e.access });
    }

    exposeNames(e.features, out);
  }

  return out;
};

async function z2mDevices({ contains, exposes }) {
  const { "bridge/devices": devices } = await retained(["bridge/devices"]);

  if (!Array.isArray(devices)) {
    throw new StepError(`No retained device list on ${config.z2mBaseTopic}/bridge/devices`);
  }

  const rows = devices.filter((d) => has(d.friendly_name, contains) || has(d.definition?.model, contains) || has(d.definition?.vendor, contains) || has(d.ieee_address, contains));

  return {
    total: devices.length,
    shown: rows.length,
    devices: rows.map((d) =>
      redactDeep({
        ...pick(d, ["friendly_name", "ieee_address", "type", "model_id", "manufacturer", "power_source", "software_build_id", "date_code", "interview_state", "interview_completed", "supported", "disabled"]),
        definition: pick(d.definition, ["model", "vendor", "description"]),
        exposes: exposes ? exposeNames(d.definition?.exposes) : undefined,
      }),
    ),
  };
}

module.exports = { haStatus, systemLog, logs, listAddons, repairs, listStates, getEntity, configEntries, getConfig, findUsage, history, z2mBridge, z2mDevices, ITEM_TYPES };
