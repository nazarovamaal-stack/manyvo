import {
  connection,
  request,
  RequestError,
  safeText as esc,
  panelURL,
  type User,
  type Study,
  type Rewards,
  type Reward,
  type Claim,
  type SpendResult,
} from "./shared.js";
const app = document.querySelector<HTMLElement>("#app")!,
  message = document.querySelector<HTMLElement>("#message")!;
let user: User | null = null,
  study: Study | null = null,
  rewards: Rewards | null = null,
  busy = false,
  rotation = 0;
const letter = (i: number) => String.fromCharCode(65 + i);
const name = (s: Study, id: string) => {
  const i = s.options.findIndex((o) => o.id === id);
  return i < 0 ? "—" : letter(i) + " · " + (s.options[i].text || "Изображение");
};
function flash(s: string) {
  message.textContent = s;
  message.classList.add("visible");
  setTimeout(() => message.classList.remove("visible"), 5000);
}
function frame(body: string, tab = "studies") {
  app.innerHTML = `<header><a class="brand" href="#">manyvo<span>✳</span></a><div class="header-actions"><span>${user?.balance ?? "—"} баллов</span><button class="icon" data-action="settings" aria-label="Настройки">⚙</button><button class="icon" data-action="expand" aria-label="Открыть в отдельной вкладке">↗</button></div></header><nav>${[
    ["studies", "Опросы"],
    ["rewards", "Награды"],
    ["mine", "Мои призы"],
    ["history", "Баллы"],
  ]
    .map(
      ([id, title]) =>
        `<a class="${tab === id ? "active" : ""}" href="#${id === "studies" ? "" : id}">${title}</a>`,
    )
    .join("")}</nav><main>${body}</main>`;
}
function coupon(c: Claim) {
  return `<article class="card"><div class="row"><h3>${esc(c.title)}</h3>${c.is_demo ? '<span class="badge">Демо</span>' : ""}</div><p>${esc(c.description)}</p><code>${esc(c.code)}</code></article>`;
}
async function studies() {
  const { studies } = await request<{ studies: Study[] }>("/api/studies");
  const open = studies.filter((s) => s.status === "open" && !s.my_answer),
    answered = studies.filter((s) => s.my_answer);
  frame(
    `<h1>Ваше мнение важно</h1><p>Выберите для себя. Предскажите большинство.</p>${open.map((s) => `<a class="card study" href="#study/${s.id}"><span class="badge">Новое исследование</span><h3>${esc(s.title)}</h3><p>${esc(s.question)}</p><div class="row"><span>1 балл + бонус за прогноз</span><strong>Участвовать →</strong></div></a>`).join("") || '<div class="card"><h3>Новых исследований пока нет</h3><p>Уведомим, когда появятся подходящие вашему профилю.</p></div>'}${answered.length ? "<h2>Ваши исследования</h2>" : ""}${answered.map((s) => `<a href="#study/${s.id}" class="card study"><span class="badge">${s.status === "closed" ? "Завершено" : "Ответ принят"}</span><h3>${esc(s.title)}</h3><p>${s.status === "closed" ? "Посмотреть результат и начисления →" : "Бонус определится после закрытия →"}</p></a>`).join("")}<button class="secondary full" data-action="sync">Проверить новые исследования</button>`,
  );
}
async function detail(id: string) {
  study = await request<Study>("/api/studies/" + encodeURIComponent(id));
  const s = study;
  if (s.my_answer) {
    frame(
      `<a href="#" class="back">← К опросам</a><h1>${s.status === "closed" ? "Результат готов" : "Спасибо за ваш выбор"}</h1><h2>${esc(s.title)}</h2><div class="card"><p>Личный выбор</p><strong>${esc(name(s, s.my_answer.personal_id))}</strong><p>Прогноз большинства</p><strong>${esc(name(s, s.my_answer.prediction_id))}</strong>${s.status === "closed" ? `<p>Лидеры личных выборов</p><strong>${s.personal_leaders?.map((id) => esc(name(s, id))).join(", ") || "Нет ответов"}</strong>${!s.complete ? "<p>Выборка неполная.</p>" : ""}` : ""}</div><div class="card row"><span>Базовый балл</span><strong>+${s.points?.base || 0}</strong></div><div class="card row"><span>Бонус за прогноз</span><strong>${s.status === "closed" ? "+" + (s.points?.bonus || 0) : "до +1"}</strong></div><a class="button full" href="#rewards">Выбрать награду</a>`,
    );
    return;
  }
  if (s.status !== "open") {
    frame(
      '<a href="#" class="back">← К опросам</a><h1>Исследование завершено</h1>',
    );
    return;
  }
  frame(
    `<a href="#" class="back">← К опросам</a><h1>${esc(s.title)}</h1><p>${esc(s.question)}</p><form id="answer">${[
      ["personal_id", "Что выбрали бы вы?"],
      ["prediction_id", "А что выберет большинство?"],
    ]
      .map(
        ([key, title], index) =>
          `<section class="card"><h2>${index + 1}. ${title}</h2>${s.options.map((o, i) => `<label class="choice"><input type="radio" name="${key}" value="${o.id}" required><span><small>ВАРИАНТ ${letter(i)}</small><span class="choice-text">${esc(o.text)}</span>${o.image ? `<img src="${esc(o.image)}" alt="Вариант ${letter(i)}">` : ""}</span></label>`).join("")}</section>`,
      )
      .join(
        "",
      )}<p class="hint">1 балл за оба ответа. Ещё 1 — за верный прогноз. После отправки изменить ответы нельзя.</p><button class="full">Отправить два ответа</button></form>`,
  );
}
async function rewardPage() {
  rewards = await request<Rewards>("/api/rewards");
  const r = rewards;
  frame(
    `<h1>Награды за ваше мнение</h1><section class="card"><h2>Колесо призов</h2><div class="wheel-wrap"><span class="pointer"></span><div class="wheel" id="wheel" style="transform:rotate(${rotation}deg)"><span class="sector a">Без приза</span><span class="sector b">Без приза</span><span class="sector c">Без приза</span><span class="sector d">Приз</span></div><span class="center">✳</span></div><h3>${esc(r.wheel.prize?.title || "Приз пока не добавлен")}</h3><p>Прокрутка — ${r.wheel.cost} балл. Четыре равновероятных сектора, шанс награды — 25%.</p>${r.wheel.prize?.is_demo ? '<p class="hint">Демокупон без денежной стоимости.</p>' : ""}<button class="full" data-action="spin" ${!r.wheel.available || r.balance < r.wheel.cost ? "disabled" : ""}>Крутить за ${r.wheel.cost} балл</button>${!r.wheel.available ? '<p class="hint">Призовые коды закончились. Списание отключено.</p>' : ""}</section><div id="spend-result" aria-live="polite"></div><h2>Гарантированные награды</h2>${r.rewards
      .filter((reward) => reward.channel === "guaranteed")
      .map(
        (reward) =>
          `<article class="card"><div class="row"><h3>${esc(reward.title)}</h3>${reward.is_demo ? '<span class="badge">Демо</span>' : ""}</div><p>${esc(reward.description)}</p><div class="row"><strong>${reward.cost} баллов</strong><span>Осталось ${reward.stock}</span></div><button class="secondary full" data-action="redeem" data-id="${reward.id}" ${reward.stock < 1 || r.balance < reward.cost ? "disabled" : ""}>${r.balance < reward.cost ? "Нужно ещё " + (reward.cost - r.balance) + " баллов" : "Получить"}</button></article>`,
      )
      .join("")}`,
    "rewards",
  );
}
async function spend(id?: string) {
  if (busy) return;
  busy = true;
  const path = id ? "/api/rewards/" + id + "/redeem" : "/api/rewards/spin";
  const pendingKey = "pending:" + user!.id + ":" + path;
  const saved = await chrome.storage.local.get(pendingKey);
  const key = saved[pendingKey] || crypto.randomUUID();
  await chrome.storage.local.set({ [pendingKey]: key });
  document
    .querySelectorAll<HTMLButtonElement>(
      "button[data-action=spin],button[data-action=redeem]",
    )
    .forEach((b) => (b.disabled = true));
  try {
    const result = await request<SpendResult>(path, "POST", {
      request_key: key,
    });
    await chrome.storage.local.remove(pendingKey);
    if (!id) {
      rotation =
        Math.floor(rotation / 360) * 360 + 2160 - (result.sector * 90 + 45);
      const wheel = document.querySelector<HTMLElement>("#wheel");
      if (wheel) wheel.style.transform = `rotate(${rotation}deg)`;
      await new Promise((resolve) => setTimeout(resolve, 1700));
    }
    user = await request<User>("/api/me");
    await rewardPage();
    const target = document.querySelector("#spend-result");
    if (target)
      target.innerHTML = `<div class="card"><h2>${result.won ? "Награда ваша!" : "В этот раз без приза"}</h2><p>Списано ${result.cost} баллов. Остаток на момент операции: ${result.balance}.</p>${result.claim ? coupon(result.claim) : ""}</div>`;
    void chrome.runtime.sendMessage({ type: "sync" });
  } catch (e) {
    if (e instanceof RequestError && e.status < 500)
      await chrome.storage.local.remove(pendingKey);
    flash(e instanceof Error ? e.message : "Не удалось выполнить операцию.");
    await rewardPage();
  } finally {
    busy = false;
  }
}
async function history() {
  const { history } = await request<{
    history: {
      kind: string;
      amount: number;
      title: string;
      created_at: number;
    }[];
  }>("/api/history");
  frame(
    `<h1>Мои баллы</h1><div class="balance"><span>Ваш баланс</span><strong>${user?.balance} баллов</strong></div>${history.map((h) => `<article class="card"><div class="row"><h3>${esc(h.title)}</h3><strong>${h.amount > 0 ? "+" : ""}${h.amount}</strong></div><p>${({ base: "Два принятых ответа", bonus: "Верный прогноз", spin: "Прокрутка колеса", redeem: "Гарантированная награда" } as Record<string, string>)[h.kind] || esc(h.kind)}</p></article>`).join("") || "<p>Начислений пока нет.</p>"}`,
    "history",
  );
}
async function mine() {
  const { claims } = await request<{ claims: Claim[] }>("/api/rewards/claims");
  frame(
    `<h1>Мои награды</h1>${claims.map(coupon).join("") || '<div class="card"><h3>Здесь появятся ваши купоны</h3><p>Коды сохраняются в аккаунте, даже если закрыть браузер.</p></div>'}`,
    "mine",
  );
}
async function render() {
  if (busy) return;
  try {
    const c = await connection();
    if (!c) {
      app.innerHTML =
        '<main><a class="brand" href="#">manyvo<span>✳</span></a><h1>Ваше мнение — в одном клике</h1><p>Подключите аккаунт участника, чтобы получать опросы и уведомления.</p><button class="full" data-action="settings">Подключить Manyvo</button></main>';
      return;
    }
    user = await request<User>("/api/me");
    const path = location.hash.slice(1);
    if (path.startsWith("study/")) await detail(path.slice(6));
    else if (path === "rewards") await rewardPage();
    else if (path === "mine") await mine();
    else if (path === "history") await history();
    else await studies();
  } catch (e) {
    frame(
      `<h1>Не удалось подключиться</h1><p>${esc(e instanceof Error ? e.message : "Проверьте адрес сервера.")}</p><button class="full" data-action="settings">Настройки подключения</button><button class="secondary full" data-action="retry">Повторить</button>`,
    );
  }
}
app.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>(
    "[data-action]",
  );
  if (!target) return;
  const action = target.dataset.action;
  if (action === "settings") void chrome.runtime.openOptionsPage();
  if (action === "expand")
    void chrome.tabs.create({ url: panelURL() + location.hash });
  if (action === "retry") void render();
  if (action === "spin") void spend();
  if (action === "redeem") void spend(target.dataset.id);
  if (action === "sync")
    void chrome.runtime.sendMessage({ type: "sync" }).then(() => render());
});
app.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || !study) return;
  const form = event.target as HTMLFormElement;
  if (form.id !== "answer") return;
  const data = new FormData(form);
  const id = study.id;
  busy = true;
  const button = form.querySelector("button")!;
  button.disabled = true;
  try {
    await request("/api/studies/" + id + "/answer", "POST", {
      personal_id: data.get("personal_id"),
      prediction_id: data.get("prediction_id"),
    });
    user = await request<User>("/api/me");
    await detail(id);
    flash("Ответы приняты. +1 балл");
    void chrome.runtime.sendMessage({ type: "sync" });
  } catch (e) {
    flash(e instanceof Error ? e.message : "Не удалось отправить.");
    button.disabled = false;
  } finally {
    busy = false;
  }
});
window.addEventListener("hashchange", () => {
  void render();
});
void render();
