import { test } from "node:test";
import assert from "node:assert/strict";
let storage = {},
  created = [],
  acks = [],
  permission = "granted",
  feed,
  failAck = false,
  failFeed = false,
  createError = false,
  badge = "";
const event = () => ({ addListener() {} });
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        if (typeof keys === "string") return { [keys]: storage[keys] };
        return Object.fromEntries(keys.map((k) => [k, storage[k]]));
      },
      async set(values) {
        Object.assign(storage, structuredClone(values));
      },
      async remove(keys) {
        for (const k of typeof keys === "string" ? [keys] : keys)
          delete storage[k];
      },
    },
  },
  alarms: {
    async get() {
      return undefined;
    },
    async create() {},
    onAlarm: event(),
  },
  runtime: {
    id: "manyvo",
    getURL: (path) => "chrome-extension://manyvo/" + path,
    onInstalled: event(),
    onStartup: event(),
    onMessage: event(),
  },
  notifications: {
    getPermissionLevel(callback) {
      callback(permission);
    },
    create(id, data, callback) {
      if (createError) {
        chrome.runtime.lastError = { message: "System notification failed" };
        callback("");
        delete chrome.runtime.lastError;
        return;
      }
      created.push({ id, data });
      callback(id);
    },
    async clear() {},
    onClicked: event(),
  },
  action: {
    async setBadgeBackgroundColor() {},
    async setBadgeText({ text }) {
      badge = text;
    },
  },
  tabs: { async create() {} },
};
globalThis.fetch = async (url, options) => {
  assert.equal(options.credentials, "omit");
  assert.equal(options.headers.Authorization, "Bearer mvo_test");
  assert.ok(url.startsWith("http://localhost:3000/api/"));
  if (url.endsWith("/feed")) {
    if (failFeed) throw new Error("offline");
    return { ok: true, json: async () => structuredClone(feed) };
  }
  if (url.endsWith("/ack")) {
    if (failAck) throw new Error("ack offline");
    acks.push(JSON.parse(options.body).ids);
    return { ok: true, json: async () => ({ ok: true }) };
  }
  throw new Error("unexpected URL");
};
const { poll } = await import("../dist/background.js");
const { originURL, request, safeText } = await import("../dist/shared.js");
function reset() {
  storage = {
    connection: {
      origin: "http://localhost:3000",
      token: "mvo_test",
      enabled: true,
    },
  };
  created = [];
  acks = [];
  permission = "granted";
  failAck = false;
  failFeed = false;
  createError = false;
  feed = {
    user: { id: "u1", name: "Anna", role: "participant", balance: 2 },
    available: [{ id: "s1", title: "Study" }],
    notifications: [
      {
        id: "n1",
        kind: "new_study",
        study_id: "s1",
        title: "Новое исследование",
        body: "Study",
        created_at: 1,
      },
    ],
  };
}
test("only HTTPS or local HTTP can receive the extension access token", () => {
  assert.equal(originURL("http://localhost:3000"), "http://localhost:3000");
  assert.equal(originURL("https://manyvo.example"), "https://manyvo.example");
  for (const value of [
    "http://evil.example",
    "https://user:pass@manyvo.example",
    "https://manyvo.example/path",
    "https://manyvo.example/?secret=test",
  ])
    assert.throws(() => originURL(value));
});
test("new study becomes a system notification and delivery receipt", async () => {
  reset();
  await poll();
  assert.equal(created.length, 1);
  assert.equal(created[0].data.title, "Новое исследование");
  assert.deepEqual(acks, [["n1"]]);
  assert.equal(badge, "1");
  assert.equal(storage.feed.user.balance, 2);
});
test("worker restart or a lost receipt does not show the same notification again", async () => {
  reset();
  failAck = true;
  await poll();
  assert.equal(created.length, 1);
  assert.match(storage.syncError, /ack offline/);
  failAck = false;
  await poll();
  assert.equal(created.length, 1);
  assert.deepEqual(acks, [["n1"]]);
});
test("blocked notifications remain pending until permission is granted", async () => {
  reset();
  permission = "denied";
  await poll();
  assert.equal(created.length, 0);
  assert.equal(acks.length, 0);
  assert.match(storage.syncError, /Разрешите/);
  permission = "granted";
  await poll();
  assert.equal(created.length, 1);
  assert.equal(acks.length, 1);
});
test("disabled notifications make no background requests", async () => {
  reset();
  storage.connection.enabled = false;
  await poll();
  assert.equal(created.length, 0);
  assert.equal(storage.feed, undefined);
});
test("network failure is reported and retried on the next poll", async () => {
  reset();
  failFeed = true;
  await poll();
  assert.equal(storage.syncError, "offline");
  failFeed = false;
  await poll();
  assert.equal(created.length, 1);
});
test("closed-study and point notifications use their persisted server payload", async () => {
  reset();
  feed.notifications = [
    {
      id: "n2",
      kind: "study_closed",
      study_id: "s1",
      title: "Исследование завершено",
      body: "Начислено 2 балла",
    },
    {
      id: "n3",
      kind: "points_bonus",
      study_id: "s1",
      title: "Начислен балл",
      body: "+1 за верный прогноз",
    },
  ];
  await poll();
  assert.equal(created.length, 2);
  assert.match(
    storage.notificationLinks["manyvo:n2"],
    /^chrome-extension:\/\/manyvo\/panel.html#study\/s1$/,
  );
});
test("untrusted content is escaped before rendering", () => {
  assert.equal(
    safeText('<img src=x onerror="alert(1)">'),
    "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
  );
});

test("browser delivery errors leave notifications unacknowledged for retry", async () => {
  reset();
  createError = true;
  await poll();
  assert.equal(created.length, 0);
  assert.equal(acks.length, 0);
  assert.match(storage.syncError, /System notification failed/);
  createError = false;
  await poll();
  assert.equal(created.length, 1);
  assert.equal(acks.length, 1);
});
