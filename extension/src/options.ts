import {
  connection,
  originURL,
  request,
  type User,
  type Connection,
} from "./shared.js";
const form = document.querySelector<HTMLFormElement>("#connect")!;
const status = document.querySelector<HTMLElement>("#status")!;
const show = (s: string) => (status.textContent = s);
async function load() {
  const c = await connection();
  if (c) {
    (form.elements.namedItem("origin") as HTMLInputElement).value = c.origin;
    (form.elements.namedItem("enabled") as HTMLInputElement).checked =
      c.enabled;
    show(
      "Браузер подключён. Чтобы сменить аккаунт, создайте новый код на сайте.",
    );
    (form.elements.namedItem("token") as HTMLInputElement).required = false;
  }
}
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = new FormData(form);
  const submit = form.querySelector("button")!;
  submit.disabled = true;
  try {
    const origin = originURL(String(data.get("origin")));
    const token = String(data.get("token") || "");
    const permitted = await chrome.permissions.request({
      origins: [origin + "/*"],
    });
    if (!permitted)
      throw new Error("Без доступа к адресу Manyvo расширение не подключится.");
    const old = await connection();
    if (!token && old && origin !== old.origin)
      throw new Error("Для другого сайта нужен новый код подключения.");
    const c: Connection = {
      origin,
      token: token || old?.token || "",
      enabled: data.has("enabled"),
    };
    if (!c.token.startsWith("mvo_"))
      throw new Error("Вставьте код из раздела «Расширение» на сайте.");
    const user = await request<User>("/api/me", "GET", undefined, c);
    if (user.role !== "participant")
      throw new Error("Подключите аккаунт участника.");
    c.userId = user.id;
    await chrome.storage.local.remove([
      "feed",
      "shown",
      "notificationLinks",
      "lastSync",
      "syncError",
    ]);
    await chrome.storage.local.set({ connection: c });
    (form.elements.namedItem("token") as HTMLInputElement).value = "";
    (form.elements.namedItem("token") as HTMLInputElement).required = false;
    await chrome.runtime.sendMessage({ type: "sync" });
    show("Подключено: " + user.name + ". Настройки сохранены.");
  } catch (e) {
    show(e instanceof Error ? e.message : "Не удалось подключиться.");
  } finally {
    submit.disabled = false;
  }
});
document.querySelector("#test")!.addEventListener("click", async () => {
  try {
    await request("/api/notifications/test", "POST", {});
    await chrome.runtime.sendMessage({ type: "sync" });
    const state = await chrome.storage.local.get("syncError");
    show(
      String(
        state.syncError ||
          "Тестовое уведомление передано браузеру. Если оно не появилось, проверьте системные настройки уведомлений.",
      ),
    );
  } catch (e) {
    show(e instanceof Error ? e.message : "Ошибка проверки.");
  }
});
document.querySelector("#disconnect")!.addEventListener("click", async () => {
  await chrome.storage.local.clear();
  await chrome.action.setBadgeText({ text: "" });
  show("Этот браузер отключён. Код можно отозвать на сайте.");
  (form.elements.namedItem("token") as HTMLInputElement).required = true;
});
void load();
