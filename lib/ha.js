// Home Assistant's REST and websocket APIs. Only the calls in tools.js are made; every one of them reads.
const WebSocket = require("ws");
const { config, StepError } = require("./config");

function explain(status, what) {
  if (status === 401) {
    return new StepError(`Home Assistant refused the token (401) for ${what}`);
  }

  if (status === 403) {
    return new StepError(`Home Assistant answered 403 for ${what}: the token's user must be an administrator`);
  }

  if (status === 404) {
    return new StepError(`Home Assistant has no ${what} (404)`);
  }

  return new StepError(`Home Assistant answered HTTP ${status} for ${what}`);
}

// GET only. `text` returns the body as text (logs), otherwise JSON.
async function get(path, { text = false, headers = {}, what = path } = {}) {
  let res;

  try {
    res = await fetch(config.haUrl + path, {
      headers: { Authorization: `Bearer ${config.haToken}`, Accept: text ? "text/plain" : "application/json", ...headers },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (e) {
    throw new StepError(`Home Assistant is not reachable at ${config.haUrl} (${e.name === "TimeoutError" ? "timeout" : e.cause?.code || e.message})`);
  }

  if (!res.ok) {
    throw explain(res.status, what);
  }

  return text ? res.text() : res.json();
}

// One websocket connection for the duration of fn({ call, firstEvent }).
async function session(fn) {
  const url = `${config.haUrl.replace(/^http/, "ws")}/api/websocket`;
  const sock = new WebSocket(url, { handshakeTimeout: config.timeoutMs, maxPayload: 64 * 1024 * 1024 });
  const inbox = [];
  const waiters = [];
  let failure = null;

  const deliver = (msg) => {
    const i = waiters.findIndex((w) => w.match(msg));

    if (i >= 0) {
      const [w] = waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(msg);
    } else {
      inbox.push(msg);
    }
  };

  const failAll = (err) => {
    failure = failure || err;

    for (const w of waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(failure);
    }
  };

  sock.on("message", (data) => {
    let parsed;

    try {
      parsed = JSON.parse(data.toString("utf-8"));
    } catch {
      return;
    }

    // HA may coalesce several messages into one array.
    for (const msg of [].concat(parsed)) {
      deliver(msg);
    }
  });
  sock.on("error", (e) => failAll(new StepError(`Home Assistant websocket failed (${e.code || e.message})`)));
  sock.on("close", () => failAll(new StepError("Home Assistant closed the websocket")));

  const wait = (match, ms = config.timeoutMs, onTimeout) =>
    new Promise((resolve, reject) => {
      const i = inbox.findIndex(match);

      if (i >= 0) {
        return resolve(inbox.splice(i, 1)[0]);
      }

      if (failure) {
        return reject(failure);
      }

      const w = { match, resolve, reject };
      w.timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(w), 1);
        onTimeout ? resolve(onTimeout()) : reject(new StepError("Home Assistant did not answer in time"));
      }, ms);
      waiters.push(w);
    });

  const send = (msg) => sock.send(JSON.stringify(msg));
  let nextId = 0;

  const result = async (id) => {
    const r = await wait((m) => m.id === id && m.type === "result");

    if (!r.success) {
      const code = r.error?.code;
      throw new StepError(code === "unauthorized" ? "Home Assistant: the token's user must be an administrator" : `Home Assistant: ${code}: ${r.error?.message}`);
    }

    return r.result;
  };

  const call = async (msg) => {
    const id = ++nextId;
    send({ ...msg, id });
    return result(id);
  };

  // Subscribes, returns the first event (a retained MQTT message arrives at once) or null, and unsubscribes.
  const firstEvent = async (msg, ms) => {
    const id = ++nextId;
    send({ ...msg, id });
    await result(id);
    const ev = await wait((m) => m.id === id && m.type === "event", ms, () => null);
    send({ type: "unsubscribe_events", subscription: id, id: ++nextId });
    return ev ? ev.event : null;
  };

  try {
    await wait((m) => m.type === "auth_required");
    send({ type: "auth", access_token: config.haToken });
    const auth = await wait((m) => m.type === "auth_ok" || m.type === "auth_invalid");

    if (auth.type !== "auth_ok") {
      throw new StepError("Home Assistant refused the token on the websocket");
    }

    return await fn({ call, firstEvent });
  } finally {
    sock.removeAllListeners("close");
    sock.on("error", () => {});
    sock.terminate();
  }
}

const ws = (msg) => session(({ call }) => call(msg));

module.exports = { get, session, ws };
