import {
  connection,
  request,
  panelURL,
  type Feed,
  type Connection,
  RequestError,
} from "./shared.js";
const alarm = "manyvo-poll";
let polling: Promise<void> | null = null;
export async function ensureAlarm() {
  if (!(await chrome.alarms.get(alarm)))
    await chrome.alarms.create(alarm, { periodInMinutes: 1 });
}
async function sync() {
  const c = await connection();
  if (!c || !c.enabled) return;
  try {
    const feed = await request<Feed>("/api/extension/feed");
    await chrome.storage.local.set({
      feed,
      lastSync: Date.now(),
      syncError: "",
    });
    await chrome.action.setBadgeBackgroundColor({ color: "#173f35" });
    await chrome.action.setBadgeText({
      text: feed.available.length ? String(feed.available.length) : "",
    });
    const data = await chrome.storage.local.get(["shown", "notificationLinks"]);
    const shown: Record<string, boolean> =
      (data.shown as Record<string, boolean>) || {};
    const links: Record<string, string> =
      (data.notificationLinks as Record<string, string>) || {};
    const delivered: string[] = [];
    for (const n of feed.notifications) {
      const key = feed.user.id + ":" + n.id;
      if (shown[key]) {
        delivered.push(n.id);
        continue;
      }
      try {
        const level = await new Promise<string>((resolve, reject) => {
          chrome.notifications.getPermissionLevel((permission) => {
            const error = chrome.runtime.lastError;
            if (error) reject(new Error(error.message));
            else resolve(permission);
          });
        });
        if (level !== "granted")
          throw new Error("Разрешите уведомления для расширения.");
        await new Promise<void>((resolve, reject) =>
          chrome.notifications.create(
            "manyvo:" + n.id,
            {
              type: "basic",
              iconUrl: chrome.runtime.getURL("icons/128.png"),
              title: n.title,
              message: n.body,
              priority: 1,
            },
            () => {
              const error = chrome.runtime.lastError;
              if (error) reject(new Error(error.message));
              else resolve();
            },
          ),
        );
        shown[key] = true;
        links["manyvo:" + n.id] = n.study_id
          ? panelURL(n.study_id)
          : panelURL() + "#" + (n.kind === "reward" ? "mine" : "history");
        await chrome.storage.local.set({ shown, notificationLinks: links });
        delivered.push(n.id);
      } catch (e) {
        await chrome.storage.local.set({
          syncError:
            e instanceof Error ? e.message : "Уведомление не удалось показать.",
        });
      }
    }
    if (delivered.length)
      await request("/api/extension/ack", "POST", { ids: delivered });
    const ids = Object.keys(shown);
    if (ids.length > 2000) {
      for (const id of ids.slice(0, ids.length - 1000)) delete shown[id];
      await chrome.storage.local.set({ shown });
    }
  } catch (e) {
    await chrome.storage.local.set({
      syncError: e instanceof Error ? e.message : "Нет связи с Manyvo.",
    });
    if (e instanceof RequestError && e.status === 401) {
      await chrome.action.setBadgeText({ text: "!" });
      await chrome.storage.local.remove("feed");
    }
  }
}
export function poll() {
  if (!polling) polling = sync().finally(() => (polling = null));
  return polling;
}
chrome.runtime.onInstalled.addListener(() => {
  void ensureAlarm();
  void poll();
});
chrome.runtime.onStartup.addListener(() => {
  void ensureAlarm();
  void poll();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === alarm) void poll();
});
chrome.notifications.onClicked.addListener(async (id) => {
  const data = await chrome.storage.local.get("notificationLinks");
  const url = (data.notificationLinks as Record<string, string> | undefined)?.[
    id
  ];
  if (typeof url === "string" && url.startsWith(chrome.runtime.getURL("")))
    await chrome.tabs.create({ url });
  await chrome.notifications.clear(id);
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message.type === "sync") {
    poll()
      .then(() => respond({ ok: true }))
      .catch(() => respond({ ok: false }));
    return true;
  }
  return false;
});
void ensureAlarm();
