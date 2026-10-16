"use client";
import {
  useEffect,
  useState,
  useCallback,
  useRef,
  type FormEvent,
  type ReactNode,
} from "react";
import { api, APIError, setCSRF } from "./api";
import type {
  User,
  Study,
  Option,
  Fact,
  Config,
  Notice,
  Rewards,
  Reward,
  Claim,
  SpendResult,
  Device,
  History,
  Metrics,
  Count,
} from "./types";
const statusLabels = {
  draft: "Черновик",
  moderating: "На модерации",
  open: "Сбор ответов",
  closed: "Завершено",
};
const letter = (n: number) => String.fromCharCode(65 + n);
const date = (t: number) =>
  new Date(t * 1000).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "Не удалось выполнить действие.";
const percent = (n: number | null) =>
  n === null
    ? "—"
    : n.toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + "%";
function Icon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    plus: <path d="M12 4v16M4 12h16" />,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    back: <path d="M20 12H4m6-6-6 6 6 6" />,
    bell: (
      <>
        <path d="M5 17h14l-2-4V8a5 5 0 0 0-10 0v5zm5 3h4" />
      </>
    ),
    gift: (
      <>
        <rect x="3" y="8" width="18" height="4" />
        <path d="M5 12v9h14v-9M12 8v13M12 8C1 8 8-3 12 8c4-11 11 0 0 0" />
      </>
    ),
    chart: <path d="M4 21h16M7 16V9m5 7V3m5 13v-5" />,
    wallet: (
      <>
        <rect x="3" y="5" width="18" height="15" rx="2" />
        <path d="M3 9h18m-5 4h5v4h-5z" />
      </>
    ),
    logout: <path d="M9 4H4v16h5m5-12 4 4-4 4m-5-4h12" />,
    check: <path d="m4 12 5 5L20 5" />,
    extension: (
      <>
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M4 8h16m-9 4v5m-3-2 3 3 3-3" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.grid}
    </svg>
  );
}
function Brand() {
  return (
    <a className="brand" href="#/">
      manyvo<span>✳</span>
    </a>
  );
}
function Badge({ study }: { study: Study }) {
  return (
    <span className={"pill " + study.status}>
      <span className="dot" />
      {statusLabels[study.status]}
    </span>
  );
}
function Back() {
  return (
    <a className="back" href="#/">
      <Icon name="back" />К исследованиям
    </a>
  );
}
function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children}
    </div>
  );
}
function Stats({ items }: { items: [string, string | number, string][] }) {
  return (
    <div className="stats">
      {items.map(([label, value, note]) => (
        <div className="stat" key={label}>
          <div className="stat-top">{label}</div>
          <span className="stat-number">{value}</span>
          <span className="stat-description">{note}</span>
        </div>
      ))}
    </div>
  );
}
function Heading({ study }: { study: Study }) {
  return (
    <>
      <Back />
      <div className="detail-heading">
        <Badge study={study} />
        <h1>{study.title || "Новое исследование"}</h1>
        <p>{study.question}</p>
      </div>
    </>
  );
}
function optionName(study: Study, id: string) {
  const i = study.options.findIndex((o) => o.id === id);
  return i < 0
    ? "—"
    : `${letter(i)} · ${study.options[i].text || "Изображение"}`;
}
export default function Manyvo() {
  const [user, setUser] = useState<User | null>(null),
    [config, setConfig] = useState<Config | null>(null),
    [loading, setLoading] = useState(true),
    [route, setRoute] = useState("/"),
    [revision, setRevision] = useState(0),
    [notices, setNotices] = useState<Notice[]>([]),
    [toast, setToast] = useState("");
  const flash = useCallback((message: string) => setToast(message), []);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    const listener = () => setRoute((location.hash || "#/").slice(1));
    listener();
    window.addEventListener("hashchange", listener);
    api<Config>("/config")
      .then(setConfig)
      .catch((e) => flash(errorText(e)));
    api<User>("/me")
      .then((u) => {
        setUser(u);
        setCSRF(u.csrf || "");
      })
      .catch(() => {})
      .finally(() => setLoading(false));
    return () => window.removeEventListener("hashchange", listener);
  }, [flash]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!user) return;
    let live = true;
    const load = async () => {
      try {
        const [u, n] = await Promise.all([
          api<User>("/me"),
          api<{ notifications: Notice[] }>("/notifications"),
        ]);
        if (live) {
          setUser(u);
          setCSRF(u.csrf || "");
          setNotices(n.notifications);
        }
      } catch (e) {
        if (e instanceof APIError && e.status === 401) {
          setUser(null);
          setCSRF("");
        }
      }
    };
    load();
    const timer = setInterval(load, 15000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [user?.id, revision]);
  async function logout() {
    try {
      await api("/logout", "POST", {});
      setUser(null);
      setCSRF("");
      location.hash = "/";
    } catch (e) {
      flash(errorText(e));
    }
  }
  if (loading)
    return (
      <main className="boot">
        <Brand />
        <p>Загружаем Manyvo…</p>
      </main>
    );
  if (!user)
    return (
      <Login
        config={config}
        onLogin={(u) => {
          setUser(u);
          setCSRF(u.csrf || "");
          refresh();
        }}
      />
    );
  const owner = user.role === "owner",
    unread = notices.filter((n) => !n.read_at).length;
  const links = owner
    ? [
        ["/", "grid", "Мои исследования"],
        ["/metrics", "chart", "Метрики"],
        ["/rewards", "gift", "Награды участникам"],
      ]
    : [
        ["/", "grid", "Исследования"],
        ["/history", "wallet", "Мои баллы"],
        ["/rewards", "gift", "Награды"],
        ["/notifications", "bell", "Уведомления"],
        ["/extension", "extension", "Расширение"],
      ];
  return (
    <>
      <div className="shell">
        <aside className="sidebar">
          <Brand />
          <div className="nav-label eyebrow">Рабочее пространство</div>
          <nav className="nav" aria-label="Навигация">
            {links.map(([path, icon, label]) => (
              <a
                key={path}
                href={"#" + path}
                className={route === path ? "active" : ""}
              >
                <Icon name={icon} />
                {label}
                {path === "/notifications" && unread > 0 && (
                  <span className="nav-count">{unread}</span>
                )}
              </a>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="sidebar-note">
              <strong>
                {owner
                  ? "Решения с опорой на людей"
                  : "Ваше мнение имеет значение"}
              </strong>
              <p>
                {owner
                  ? "Личные предпочтения и прогноз большинства — два взгляда на ваш следующий шаг."
                  : "Отвечайте, прогнозируйте, копите баллы и выбирайте награды."}
              </p>
            </div>
            <div className="user-block">
              <div className="avatar">{user.name[0]}</div>
              <div>
                <div className="user-name">{user.name}</div>
                <div className="user-role">
                  {owner ? "Заказчик" : "Участник"}
                </div>
              </div>
              <button
                className="icon-button"
                onClick={logout}
                aria-label="Выйти"
              >
                <Icon name="logout" />
              </button>
            </div>
          </div>
        </aside>
        <div className="workspace">
          <header className="topbar">
            <span className="crumb">Рабочее пространство / Manyvo</span>
            <div className="topbar-right">
              {config?.demo && (
                <span className="pill">Деморежим модерации</span>
              )}
              {!owner && (
                <>
                  <a
                    className="text-link"
                    href="#/notifications"
                    aria-label={`Уведомления: ${unread}`}
                  >
                    <Icon name="bell" />
                    {unread || ""}
                  </a>
                  <a className="text-link" href="#/history">
                    {user.balance} баллов
                  </a>
                </>
              )}
              <button
                className="icon-button"
                onClick={logout}
                aria-label="Выйти"
              >
                <Icon name="logout" />
              </button>
            </div>
          </header>
          <main className="workspace-main" id="main">
            <Content
              key={route}
              route={route}
              user={user}
              revision={revision}
              refresh={refresh}
              flash={flash}
              notices={notices}
            />
            <footer className="page-foot">
              <span>manyvo · От мнений к обоснованным решениям</span>
              <span>Личный выбор. Прогноз. Проверка.</span>
            </footer>
          </main>
        </div>
      </div>
      {toast && (
        <div className="toast show" role="status">
          {toast}
        </div>
      )}
    </>
  );
}
function Login({
  config,
  onLogin,
}: {
  config: Config | null;
  onLogin: (u: User) => void;
}) {
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [register, setRegister] = useState(false),
    [name, setName] = useState(""),
    [role, setRole] = useState("participant"),
    [age, setAge] = useState(18),
    [country, setCountry] = useState("Россия");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const s = await api<{ csrf: string }>(
        register ? "/register" : "/login",
        "POST",
        register
          ? { email, password, name, role, age, country }
          : { email, password },
      );
      setCSRF(s.csrf);
      onLogin(await api<User>("/me"));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <section className="login-story">
        <Brand />
        <div className="login-pitch">
          <div
            className="eyebrow"
            style={{ color: "#b6cda3", marginBottom: 22 }}
          >
            Прогнозные микроисследования
          </div>
          <h1>
            Хорошие решения
            <br />
            начинаются
            <br />с <em>другого мнения.</em>
          </h1>
          <p>
            Узнайте, что выбирают люди, чего ждут от большинства и как это
            соотносится с реальностью.
          </p>
          <div className="login-art" aria-hidden="true">
            <div>A</div>
            <div>B ↗</div>
            <div>C</div>
          </div>
        </div>
        <div className="login-story-foot">ЛИЧНЫЙ ВЫБОР / ПРОГНОЗ / ФАКТ</div>
      </section>
      <section className="login-form-side">
        <div className="login-box">
          <h2>{register ? "Присоединиться к Manyvo" : "Рады видеть вас"}</h2>
          <p>
            {register
              ? "Создайте аккаунт для исследований и наград."
              : "Войдите, чтобы продолжить исследование."}
          </p>
          <form onSubmit={submit}>
            {register && (
              <>
                <div className="field">
                  <label>
                    Имя
                    <input
                      value={name}
                      maxLength={80}
                      onChange={(e) => setName(e.target.value)}
                      required
                      autoComplete="name"
                    />
                  </label>
                </div>
                <div className="field">
                  <label>
                    Роль
                    <select
                      value={role}
                      onChange={(e) => setRole(e.target.value)}
                    >
                      <option value="participant">Участник исследований</option>
                      <option value="owner">Заказчик исследований</option>
                    </select>
                  </label>
                </div>
                <div className="form-grid field">
                  <label>
                    Возраст
                    <input
                      type="number"
                      min={18}
                      max={120}
                      value={age}
                      onChange={(e) => setAge(Number(e.target.value))}
                      required
                    />
                  </label>
                  <label>
                    Страна
                    <input
                      value={country}
                      maxLength={80}
                      onChange={(e) => setCountry(e.target.value)}
                      required
                    />
                  </label>
                </div>
              </>
            )}
            <div className="field">
              <label>
                Электронная почта
                <input
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </label>
            </div>
            <div className="field">
              <label>
                Пароль
                <input
                  type="password"
                  autoComplete={register ? "new-password" : "current-password"}
                  minLength={register ? 10 : undefined}
                  maxLength={128}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </label>
            </div>
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
            <button className="button wide" disabled={busy}>
              {busy
                ? "Подождите…"
                : register
                  ? "Создать аккаунт"
                  : "Войти в Manyvo"}
              <Icon name="arrow" />
            </button>
          </form>
          <button
            className="button ghost wide"
            type="button"
            onClick={() => {
              setRegister(!register);
              setError("");
            }}
          >
            {register
              ? "Уже есть аккаунт? Войти"
              : "Нет аккаунта? Зарегистрироваться"}
          </button>
          {!!config?.demo_accounts?.length && !register && (
            <div className="demo-divider">
              <p>
                Демонстрационные аккаунты. Пароль: <strong>manyvo-demo</strong>
              </p>
              <div className="demo-accounts">
                {config.demo_accounts.map((a) => (
                  <button
                    key={a.email}
                    className="demo-account"
                    onClick={() => {
                      setEmail(a.email);
                      setPassword("manyvo-demo");
                    }}
                  >
                    {a.name} · {a.role === "owner" ? "заказчик" : "участник"}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
type Common = {
  user: User;
  revision: number;
  refresh: () => void;
  flash: (m: string) => void;
};
function Content(props: Common & { route: string; notices: Notice[] }) {
  const { route, user, revision, refresh, flash } = props;
  const [data, setData] = useState<unknown>(null),
    [error, setError] = useState("");
  const creation = useRef<Promise<Study> | null>(null);
  useEffect(() => {
    let active = true;
    setError("");
    const load = async () => {
      try {
        let result: unknown;
        if (route === "/new") {
          if (!creation.current)
            creation.current = api<Study>("/studies", "POST", {}).catch(
              (error) => {
                creation.current = null;
                throw error;
              },
            );
          result = await creation.current;
          if (active) location.hash = "/study/" + (result as Study).id;
          return;
        }
        const endpoint =
          route === "/"
            ? "/studies"
            : route.startsWith("/study/")
              ? "/studies/" + route.slice(7)
              : route === "/extension"
                ? "/devices"
                : route === "/rewards"
                  ? "/rewards"
                  : route;
        result = await api(endpoint);
        if (active) setData(result);
      } catch (e) {
        if (active) setError(errorText(e));
      }
    };
    load();
    let timer: ReturnType<typeof setInterval> | undefined;
    if (route === "/" || route.startsWith("/study/"))
      timer = setInterval(async () => {
        if (document.hidden) return;
        try {
          const endpoint =
            route === "/" ? "/studies" : "/studies/" + route.slice(7);
          const result = await api<Study | { studies: Study[] }>(endpoint);
          if (active)
            setData((old: unknown) => {
              if (route !== "/" && (old as Study)?.status === "draft")
                return old;
              return result;
            });
        } catch {}
      }, 4000);
    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [route, revision]);
  if (error)
    return (
      <>
        <Back />
        <Empty title="Не удалось открыть страницу">
          <p>{error}</p>
          <button className="button" onClick={refresh}>
            Повторить
          </button>
        </Empty>
      </>
    );
  if (!data)
    return (
      <div className="boot" style={{ padding: "35px 0" }}>
        <p>Загружаем…</p>
      </div>
    );
  if (route === "/")
    return (
      <StudyList studies={(data as { studies: Study[] }).studies} user={user} />
    );
  if (route.startsWith("/study/")) {
    const study = data as Study;
    if (user.role === "owner" && study.status === "draft")
      return (
        <Editor
          key={study.id + study.version}
          study={study}
          refresh={refresh}
          flash={flash}
        />
      );
    if (user.role === "owner")
      return <OwnerStudy study={study} refresh={refresh} flash={flash} />;
    return <ParticipantStudy study={study} refresh={refresh} flash={flash} />;
  }
  if (route === "/history")
    return (
      <HistoryView
        user={user}
        rows={(data as { history: History[] }).history}
      />
    );
  if (route === "/metrics") return <MetricsView data={data as Metrics} />;
  if (route === "/notifications")
    return (
      <Notifications
        notices={(data as { notifications: Notice[] }).notifications}
        refresh={refresh}
        flash={flash}
      />
    );
  if (route === "/extension")
    return (
      <Devices
        devices={(data as { devices: Device[] }).devices}
        refresh={refresh}
        flash={flash}
      />
    );
  if (route === "/rewards")
    return <RewardsView data={data as Rewards} {...props} />;
  return <Empty title="Страница не найдена" />;
}
function StudyList({ studies, user }: { studies: Study[]; user: User }) {
  const [filter, setFilter] = useState("all"),
    [search, setSearch] = useState("");
  const owner = user.role === "owner";
  const shown = studies.filter(
    (s) =>
      (filter === "all" ||
        (filter === "answered" ? s.my_answer : s.status === filter)) &&
      (s.title + " " + s.question).toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <div className="row spread page-heading">
        <div>
          <h1>{owner ? "Мои исследования" : "Новый взгляд — ваш"}</h1>
          <p>
            {owner
              ? "Задавайте вопросы. Выбирайте увереннее."
              : "Выберите для себя. Предскажите выбор большинства."}
          </p>
        </div>
        {owner && (
          <a className="button" href="#/new">
            <Icon name="plus" />
            Создать исследование
          </a>
        )}
      </div>
      <section className="hero">
        <div>
          <div className="eyebrow">
            {owner
              ? "От вопроса к решению"
              : "Небольшой выбор. Большая польза."}
          </div>
          <h2>
            {owner
              ? "Не гадайте, какой вариант сработает. Спросите людей."
              : "Что нравится вам? А что выберет большинство?"}
          </h2>
          <p>
            {owner
              ? "От 2 до 5 вариантов, нужная аудитория и два независимых взгляда."
              : "Два ответа принесут 1 балл. Верный прогноз — ещё 1. Копите на награды или попробуйте колесо призов."}
          </p>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="art-card">
            <span className="art-letter">a</span>
          </div>
          <div className="art-card">
            <span className="art-flower" />
          </div>
        </div>
      </section>
      <Stats
        items={
          owner
            ? [
                ["Исследований", studies.length, "в вашем пространстве"],
                [
                  "Собирают ответы",
                  studies.filter((s) => s.status === "open").length,
                  "прямо сейчас",
                ],
                [
                  "Принято ответов",
                  studies.reduce((n, s) => n + (s.count || 0), 0),
                  "личный выбор + прогноз",
                ],
              ]
            : [
                [
                  "Доступно",
                  studies.filter((s) => s.status === "open" && !s.my_answer)
                    .length,
                  "для вашего профиля",
                ],
                [
                  "Ваши ответы",
                  studies.filter((s) => s.my_answer).length,
                  "вклад в исследования",
                ],
                ["Баланс", user.balance, "можно потратить на награды"],
              ]
        }
      />
      <div className="toolbar">
        <div className="tabs">
          {(owner
            ? [
                ["all", "Все"],
                ["open", "Активные"],
                ["draft", "Черновики"],
                ["closed", "Завершённые"],
              ]
            : [
                ["all", "Все"],
                ["open", "Открытые"],
                ["answered", "Мои ответы"],
              ]
          ).map(([id, title]) => (
            <button
              key={id}
              onClick={() => setFilter(id)}
              className={"tab " + (filter === id ? "active" : "")}
            >
              {title}
            </button>
          ))}
        </div>
        <input
          className="list-search"
          type="search"
          placeholder="Найти исследование"
          aria-label="Найти исследование"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="study-grid">
        {shown.map((s) => (
          <article className="study-card" key={s.id}>
            <div className="row spread card-top">
              <Badge study={s} />
              <span className="study-code">
                #{s.id.slice(0, 6).toUpperCase()}
              </span>
            </div>
            <h3>{s.title || "Новое исследование"}</h3>
            <p>
              {s.question || "Добавьте вопрос и варианты, когда будете готовы."}
            </p>
            <div className="card-meta">
              {s.country || "Аудитория не выбрана"}{" "}
              {s.age_min && `· ${s.age_min}–${s.age_max} лет`}
            </div>
            {owner && s.status !== "draft" && (
              <div className="progress">
                <span
                  style={{
                    width: (100 * (s.count || 0)) / (s.quota || 50) + "%",
                  }}
                />
              </div>
            )}
            <div className="row spread card-bottom">
              <span className="muted">
                {owner
                  ? `${s.count || 0} / ${s.quota || 50} ответов`
                  : s.my_answer
                    ? "Ответ принят"
                    : "1 балл + бонус"}
              </span>
              <a href={"#/study/" + s.id} className="text-link">
                {owner
                  ? s.status === "draft"
                    ? "Продолжить"
                    : s.status === "closed"
                      ? "Результаты"
                      : "Открыть"
                  : s.my_answer
                    ? "Мой результат"
                    : "Участвовать"}
                <Icon name="arrow" />
              </a>
            </div>
          </article>
        ))}
        {owner && filter === "all" && !search && (
          <a className="new-card" href="#/new">
            <span className="new-icon">
              <Icon name="plus" />
            </span>
            <h3>Следующий вопрос — ваш</h3>
            <p>Создайте исследование и узнайте мнение аудитории.</p>
          </a>
        )}
      </div>
      {shown.length === 0 && !owner && (
        <Empty title="Подходящих исследований пока нет">
          <p>Расширение сообщит, когда появится новый опрос.</p>
          <a className="button secondary" href="#/extension">
            Подключить расширение
          </a>
        </Empty>
      )}
    </>
  );
}
function Editor({
  study,
  refresh,
  flash,
}: {
  study: Study;
  refresh: () => void;
  flash: (m: string) => void;
}) {
  const [d, setD] = useState(study),
    [busy, setBusy] = useState(false);
  const update = (p: Partial<Study>) => setD((old) => ({ ...old, ...p }));
  const option = (i: number, p: Partial<Option>) =>
    setD((old) => ({
      ...old,
      options: old.options.map((o, j) => (i === j ? { ...o, ...p } : o)),
    }));
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const publish =
      (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value") ===
      "publish";
    setBusy(true);
    try {
      await api("/studies/" + d.id, "PUT", {
        title: d.title,
        question: d.question,
        version: d.version,
        quota: d.quota,
        age_min: d.age_min,
        age_max: d.age_max,
        country: d.country,
        options: d.options,
      });
      if (publish) await api("/studies/" + d.id + "/publish", "POST", {});
      flash(
        publish
          ? "Исследование отправлено в очередь модерации"
          : "Черновик сохранён",
      );
      refresh();
    } catch (e) {
      flash(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function file(i: number, f: File | undefined) {
    if (!f) return;
    if (
      !["image/png", "image/jpeg"].includes(f.type) ||
      f.size > 5 * 1024 * 1024
    ) {
      flash("Выберите PNG или JPEG до 5 МБ.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => option(i, { image: String(reader.result) });
    reader.readAsDataURL(f);
  }
  return (
    <>
      <Back />
      <div className="page-heading">
        <h1>С чего начнём?</h1>
        <p>Сохраните идею сейчас. Опубликуйте, когда всё будет готово.</p>
      </div>
      {study.moderation_reason && (
        <div className="notice error" role="alert">
          {study.moderation_reason}
        </div>
      )}
      <form onSubmit={submit}>
        <fieldset disabled={busy} className="plain-fieldset">
          <div className="form-layout">
            <div>
              <section className="panel">
                <h2>01 · Ваш вопрос</h2>
                <div className="field">
                  <label>
                    Название исследования
                    <input
                      maxLength={120}
                      value={d.title}
                      onChange={(e) => update({ title: e.target.value })}
                    />
                  </label>
                </div>
                <label>
                  Вопрос для участников
                  <textarea
                    maxLength={500}
                    value={d.question}
                    onChange={(e) => update({ question: e.target.value })}
                  />
                </label>
              </section>
              <section className="panel">
                <h2>02 · Варианты</h2>
                {d.options.map((o, i) => (
                  <div className="option-editor" key={i}>
                    <div className="row spread">
                      <span className="option-label">ВАРИАНТ {letter(i)}</span>
                      <button
                        type="button"
                        className="option-remove"
                        onClick={() =>
                          update({
                            options: d.options.filter((_, j) => j !== i),
                          })
                        }
                      >
                        Удалить
                      </button>
                    </div>
                    <label className="sr-only" htmlFor={"option-" + i}>
                      Вариант {letter(i)}
                    </label>
                    <textarea
                      id={"option-" + i}
                      maxLength={500}
                      value={o.text}
                      onChange={(e) => option(i, { text: e.target.value })}
                    />
                    {o.image && (
                      <>
                        <img
                          className="option-preview"
                          src={o.image}
                          alt={"Вариант " + letter(i)}
                        />
                        <button
                          className="option-remove"
                          type="button"
                          onClick={() => option(i, { image: null })}
                        >
                          Убрать изображение
                        </button>
                      </>
                    )}
                    <label className="upload">
                      PNG или JPEG до 5 МБ
                      <input
                        type="file"
                        accept="image/png,image/jpeg"
                        onChange={(e) => file(i, e.target.files?.[0])}
                      />
                    </label>
                  </div>
                ))}
                <button
                  className="button secondary wide"
                  disabled={d.options.length >= 5 || busy}
                  type="button"
                  onClick={() =>
                    update({
                      options: [
                        ...d.options,
                        { id: "", text: "", position: d.options.length },
                      ],
                    })
                  }
                >
                  <Icon name="plus" />
                  Добавить вариант
                </button>
                <p className="field-help">
                  Для публикации нужны 2–5 заполненных вариантов.
                </p>
              </section>
              <section className="panel">
                <h2>03 · Аудитория и сбор</h2>
                <div className="form-grid">
                  <label>
                    Страна
                    <input
                      value={d.country}
                      onChange={(e) => update({ country: e.target.value })}
                      placeholder="Россия"
                    />
                  </label>
                  <label>
                    Количество ответов
                    <input
                      type="number"
                      min={2}
                      max={500}
                      value={d.quota ?? ""}
                      placeholder="50 по умолчанию"
                      onChange={(e) =>
                        update({
                          quota:
                            e.target.value === ""
                              ? null
                              : Number(e.target.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    Возраст от
                    <input
                      type="number"
                      min={18}
                      max={120}
                      value={d.age_min ?? ""}
                      onChange={(e) =>
                        update({
                          age_min:
                            e.target.value === ""
                              ? null
                              : Number(e.target.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    Возраст до
                    <input
                      type="number"
                      min={18}
                      max={120}
                      value={d.age_max ?? ""}
                      onChange={(e) =>
                        update({
                          age_max:
                            e.target.value === ""
                              ? null
                              : Number(e.target.value),
                        })
                      }
                    />
                  </label>
                </div>
                <p className="field-help">
                  Сбор завершится по квоте или через 24 часа.
                </p>
              </section>
              <div className="form-actions">
                <button className="button secondary" value="save">
                  Сохранить черновик
                </button>
                <button className="button" value="publish">
                  {busy ? "Сохраняем…" : "Отправить на модерацию"}
                </button>
              </div>
            </div>
            <aside className="form-side">
              <div className="panel">
                <h3>Как это работает</h3>
                <ol className="flow-list">
                  <li>Задайте вопрос, варианты и аудиторию.</li>
                  <li>Материалы пройдут ИИ-модерацию.</li>
                  <li>
                    Участники выберут для себя и спрогнозируют большинство.
                  </li>
                  <li>
                    Получите два распределения и проверьте прогноз на факте.
                  </li>
                </ol>
                <div className="notice">
                  После публикации варианты нельзя изменить.
                </div>
              </div>
            </aside>
          </div>
        </fieldset>
      </form>
    </>
  );
}
function OwnerStudy({
  study: s,
  refresh,
  flash,
}: {
  study: Study;
  refresh: () => void;
  flash: (m: string) => void;
}) {
  if (s.status === "closed")
    return <Report study={s} refresh={refresh} flash={flash} />;
  return (
    <>
      <Heading study={s} />
      {s.status === "moderating" ? (
        <Empty title="Материалы в очереди модерации">
          <p>Проверяем все варианты. Страница обновится автоматически.</p>
        </Empty>
      ) : (
        <>
          <section className="panel">
            <Stats
              items={[
                [
                  `${s.country} · ${s.age_min}–${s.age_max} лет`,
                  `${s.count} / ${s.quota}`,
                  "принято ответов",
                ],
                ["Завершение", date(s.deadline || 0), "по квоте или сроку"],
                ["Вариантов", s.options.length, "один вопрос для всех"],
              ]}
            />
            <div className="notice">
              Распределения появятся после закрытия. Пока доступно число
              принятых ответов.
            </div>
          </section>
          <OptionTiles options={s.options} />
        </>
      )}
    </>
  );
}
function OptionTiles({ options }: { options: Option[] }) {
  return (
    <div className="option-list">
      {options.map((o, i) => (
        <div className="option-tile" key={o.id}>
          <span className="option-label">ВАРИАНТ {letter(i)}</span>
          <p>{o.text}</p>
          {o.image && <img src={o.image} alt={"Вариант " + letter(i)} />}
        </div>
      ))}
    </div>
  );
}
function ParticipantStudy({
  study: s,
  refresh,
  flash,
}: {
  study: Study;
  refresh: () => void;
  flash: (m: string) => void;
}) {
  const [personal, setPersonal] = useState(""),
    [prediction, setPrediction] = useState(""),
    [busy, setBusy] = useState(false);
  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/studies/" + s.id + "/answer", "POST", {
        personal_id: personal,
        prediction_id: prediction,
      });
      refresh();
      flash("Ответы приняты. +1 базовый балл");
    } catch (e) {
      flash(errorText(e));
      refresh();
    } finally {
      setBusy(false);
    }
  }
  if (s.my_answer)
    return (
      <>
        <Back />
        <section className="receipt">
          <div className="success-icon">
            <Icon name="check" />
          </div>
          <h2>
            {s.status === "closed"
              ? "Ваш результат готов"
              : "Спасибо за ваш выбор"}
          </h2>
          <p>{s.title}</p>
          <div className="panel">
            <h3>Ваш личный выбор</h3>
            <p>{optionName(s, s.my_answer.personal_id)}</p>
            <h3>Ваш прогноз</h3>
            <p>{optionName(s, s.my_answer.prediction_id)}</p>
            {s.status === "closed" && (
              <>
                <h3>Лидеры личных выборов</h3>
                <p>
                  {s.personal_leaders
                    ?.map((id) => optionName(s, id))
                    .join(", ") || "Нет ответов"}
                </p>
                {!s.complete && (
                  <p className="small muted">Выборка неполная.</p>
                )}
              </>
            )}
          </div>
          <div className="point-badge">
            <span>Базовый балл</span>
            <strong>+{s.points?.base || 0}</strong>
          </div>
          <div className="point-badge">
            <span>Бонус за прогноз</span>
            <strong>
              {s.status === "closed" ? "+" + (s.points?.bonus || 0) : "до +1"}
            </strong>
          </div>
          <p>
            {s.status === "closed"
              ? "Баллы доступны для колеса и гарантированных наград."
              : "После закрытия пришлём уведомление об итоге."}
          </p>
          <a className="button" href="#/rewards">
            Выбрать награду
          </a>
        </section>
      </>
    );
  if (s.status !== "open") return <Empty title="Исследование завершено" />;
  return (
    <>
      <Heading study={s} />
      <div className="notice">
        1 балл за два ответа. Ещё 1 — за верный прогноз. Ваш выбор и прогноз
        могут совпадать.
      </div>
      <form onSubmit={send}>
        {[
          ["personal", "Что выбрали бы вы?", personal, setPersonal],
          [
            "prediction",
            "А что выберет большинство?",
            prediction,
            setPrediction,
          ],
        ].map(([name, title, value, setter], i) => (
          <section className="panel question-step" key={String(name)}>
            <h2>
              <span className="step-number">{i + 1}</span>
              {String(title)}
            </h2>
            <div className="option-list">
              {s.options.map((o, j) => (
                <label className="choice-tile" key={o.id}>
                  <input
                    type="radio"
                    name={String(name)}
                    value={o.id}
                    checked={value === o.id}
                    onChange={() => {
                      (setter as (v: string) => void)(o.id);
                    }}
                    required
                  />
                  <div>
                    <span className="option-label">ВАРИАНТ {letter(j)}</span>
                    <p>{o.text}</p>
                    {o.image && (
                      <img src={o.image} alt={"Вариант " + letter(j)} />
                    )}
                  </div>
                </label>
              ))}
            </div>
          </section>
        ))}
        <div className="form-actions">
          <button disabled={busy} className="button">
            Отправить два ответа
            <Icon name="arrow" />
          </button>
        </div>
      </form>
    </>
  );
}
function Chart({
  rows,
  leaders,
  title,
  orange = false,
}: {
  rows: Count[];
  leaders: string[];
  title: string;
  orange?: boolean;
}) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {rows.map((r) => (
        <div className="chart-row" key={r.id}>
          <div className="chart-label">
            <span>
              {letter(r.position)} · {r.text || "Изображение"}
            </span>
            <strong>
              {r.count} · {percent(r.percent)}
            </strong>
          </div>
          <div className="chart-track">
            <div
              className={"chart-fill " + (orange ? "prediction" : "")}
              style={{ width: r.percent + "%" }}
            />
          </div>
        </div>
      ))}
      <p className="leader-note">
        {leaders.length > 1 ? "Ничья. Лидеры" : "Лидер"}:{" "}
        {leaders
          .map((id) => letter(rows.find((r) => r.id === id)?.position || 0))
          .join(", ") || "нет"}
      </p>
    </section>
  );
}
function Report({
  study: s,
  refresh,
  flash,
}: {
  study: Study;
  refresh: () => void;
  flash: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false),
    [rate, setRate] = useState(!!s.comparison?.fact?.is_rate);
  const old = s.comparison?.fact;
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const fact: Fact = {
      metric: String(data.get("metric")),
      unit: String(data.get("unit")),
      start_date: String(data.get("start")),
      end_date: String(data.get("end")),
      is_rate: rate,
      values: s.options.map((o) => ({
        option_id: o.id,
        value: Number(data.get("value-" + o.id)),
        denominator: rate ? Number(data.get("denominator-" + o.id)) : null,
      })),
    };
    setBusy(true);
    try {
      await api("/studies/" + s.id + "/fact", "POST", fact);
      flash("Факт сохранён. Сверка обновлена");
      refresh();
    } catch (e) {
      flash(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Heading study={s} />
      {!s.complete && (
        <div className="notice">
          Выборка неполная: {s.count} из {s.quota} запланированных ответов.
        </div>
      )}
      <Stats
        items={[
          [`Квота ${s.quota}`, s.count || 0, "принято ответов"],
          [
            "Выборка",
            s.complete ? "Полная" : "Неполная",
            "фиксируется при закрытии",
          ],
          ["Закрыто", date(s.closed_at || 0), "результат зафиксирован"],
        ]}
      />
      <div className="result-columns">
        <Chart
          rows={s.personal || []}
          leaders={s.personal_leaders || []}
          title="Личные предпочтения"
        />
        <Chart
          rows={s.predictions || []}
          leaders={s.prediction_leaders || []}
          title="Прогноз большинства"
          orange
        />
      </div>
      <div className="comparison">
        <h3>Прогноз и реальный результат</h3>
        <h2>{s.comparison?.label}</h2>
        <p>
          Сравниваем лидеров прогнозов с лидерами бизнес-метрики. Правка факта
          не меняет ответы и баллы.
        </p>
      </div>
      <form className="panel" onSubmit={submit} key={old?.version || 0}>
        <h2>
          {old
            ? "Обновить факт · версия " + old.version
            : "Добавить фактические данные"}
        </h2>
        <div className="fact-grid">
          <label>
            Метрика
            <input
              name="metric"
              required
              maxLength={120}
              defaultValue={old?.metric}
            />
          </label>
          <label>
            Единица измерения
            <input
              name="unit"
              required
              maxLength={40}
              defaultValue={old?.unit}
            />
          </label>
          <label>
            Начало периода
            <input
              type="date"
              name="start"
              required
              defaultValue={old?.start_date}
            />
          </label>
          <label>
            Конец периода
            <input
              type="date"
              name="end"
              required
              defaultValue={old?.end_date}
            />
          </label>
        </div>
        <label className="check-label">
          <input
            type="checkbox"
            checked={rate}
            onChange={(e) => setRate(e.target.checked)}
          />
          Ставка или доля, например CTR. Укажу знаменатели.
        </label>
        {s.options.map((o, i) => {
          const v = old?.values.find((v) => v.option_id === o.id);
          return (
            <div className="fact-variant" key={o.id}>
              <p>
                {letter(i)} · {o.text || "Изображение"}
              </p>
              <div className="fact-grid">
                <label>
                  Значение
                  <input
                    name={"value-" + o.id}
                    type="number"
                    min={0}
                    step="any"
                    required
                    defaultValue={v?.value}
                  />
                </label>
                {rate && (
                  <label>
                    Знаменатель
                    <input
                      name={"denominator-" + o.id}
                      type="number"
                      min={0.00000001}
                      step="any"
                      required
                      defaultValue={v?.denominator ?? ""}
                    />
                  </label>
                )}
              </div>
            </div>
          );
        })}
        <div className="form-actions" style={{ marginTop: 20 }}>
          <button disabled={busy} className="button">
            Сохранить и сверить
          </button>
        </div>
      </form>
    </>
  );
}
function HistoryView({ user, rows }: { user: User; rows: History[] }) {
  return (
    <>
      <div className="page-heading">
        <h1>Мои баллы</h1>
        <p>Начисления за ответы и прогнозы, расходы на награды.</p>
      </div>
      <div className="balance-hero">
        <div className="eyebrow">Ваш баланс</div>
        <div className="balance-number">
          {user.balance}{" "}
          <span style={{ fontSize: 20, letterSpacing: 0 }}>баллов</span>
        </div>
        <p>1 за два ответа, ещё 1 за верный прогноз. Прокрутка стоит 1 балл.</p>
      </div>
      <section className="panel">
        <h2>История операций</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Исследование или награда</th>
                <th>Операция</th>
                <th>Дата</th>
                <th>Баллы</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    {r.study_id ? (
                      <a href={"#/study/" + r.study_id}>{r.title}</a>
                    ) : (
                      r.title
                    )}
                  </td>
                  <td>
                    {{
                      base: "Участие",
                      bonus: "Верный прогноз",
                      spin: "Колесо призов",
                      redeem: "Обмен на награду",
                    }[r.kind] || r.kind}
                  </td>
                  <td>{date(r.created_at)}</td>
                  <td className={r.amount > 0 ? "positive" : "muted"}>
                    {r.amount > 0 ? "+" : ""}
                    {r.amount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <p className="small muted">Операций пока нет.</p>}
        </div>
      </section>
    </>
  );
}
function MetricsView({ data: m }: { data: Metrics }) {
  return (
    <>
      <div className="page-heading">
        <h1>Метрики исследований</h1>
        <p>Измеряем набор, завершение и совпадение с фактом.</p>
      </div>
      <Stats
        items={[
          [
            "Завершили ответы",
            percent(m.completion_percent),
            `${m.pairs} пар / ${m.starts} начал`,
          ],
          [
            "Совпадение с фактом",
            percent(m.agreement_percent),
            `${m.comparable} однозначных сверок`,
          ],
          ["Исследований", m.studies.length, "после публикации"],
        ]}
      />
      <div className="notice">
        Цели пилота: 50 ответов за 60 минут и завершение ≥80%. Демоисследования
        не подтверждают достижение этих целей.
      </div>
      <section className="panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Исследование</th>
                <th>Начали</th>
                <th>Ответили</th>
                <th>До 50-го ответа</th>
              </tr>
            </thead>
            <tbody>
              {m.studies.map((s) => (
                <tr key={s.id}>
                  <td>
                    <a href={"#/study/" + s.id}>{s.title}</a>
                  </td>
                  <td>{s.starts}</td>
                  <td>
                    {s.pairs} / {s.quota}
                  </td>
                  <td>
                    {s.quota !== 50
                      ? "Другая квота"
                      : s.t50_seconds === null
                        ? "Не набраны"
                        : Math.ceil(s.t50_seconds / 60) + " мин"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <p className="small muted">
        Ничьи: {m.ties}. Нет факта или ответов: {m.missing}.
      </p>
    </>
  );
}
function Notifications({
  notices,
  refresh,
  flash,
}: {
  notices: Notice[];
  refresh: () => void;
  flash: (m: string) => void;
}) {
  async function read() {
    try {
      await api("/notifications/read", "POST", {
        ids: notices.filter((n) => !n.read_at).map((n) => n.id),
      });
      refresh();
    } catch (e) {
      flash(errorText(e));
    }
  }
  return (
    <>
      <div className="row spread page-heading">
        <div>
          <h1>Уведомления</h1>
          <p>Новые опросы, итоги, баллы и награды.</p>
        </div>
        <button
          className="button secondary"
          onClick={read}
          disabled={!notices.some((n) => !n.read_at)}
        >
          Прочитать все
        </button>
      </div>
      {notices.length ? (
        notices.map((n) => (
          <article
            className={"panel notice-card " + (!n.read_at ? "unread" : "")}
            key={n.id}
          >
            <div className="row spread">
              <h3>{n.title}</h3>
              <span className="small muted">{date(n.created_at)}</span>
            </div>
            <p>{n.body}</p>
            {n.study_id && (
              <a className="text-link" href={"#/study/" + n.study_id}>
                К исследованию
                <Icon name="arrow" />
              </a>
            )}
            {n.kind === "reward" && (
              <a className="text-link" href="#/rewards">
                Мои награды
                <Icon name="arrow" />
              </a>
            )}
          </article>
        ))
      ) : (
        <Empty title="Уведомлений пока нет">
          <p>
            Подключите расширение, чтобы узнавать о новых опросах, даже когда
            сайт закрыт.
          </p>
          <a href="#/extension" className="button">
            Подключить расширение
          </a>
        </Empty>
      )}
    </>
  );
}
function Devices({
  devices,
  refresh,
  flash,
}: {
  devices: Device[];
  refresh: () => void;
  flash: (m: string) => void;
}) {
  const [token, setToken] = useState(""),
    [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true);
    try {
      const result = await api<{ token: string }>("/devices", "POST", {
        name: "Мой Яндекс Браузер",
      });
      setToken(result.token);
      refresh();
      flash("Код подключения создан");
    } catch (e) {
      flash(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    try {
      await api("/devices/" + id, "POST", {});
      refresh();
    } catch (e) {
      flash(errorText(e));
    }
  }
  return (
    <>
      <div className="page-heading">
        <h1>Расширение Manyvo</h1>
        <p>Исследования, уведомления, баллы и награды в Яндекс Браузере.</p>
      </div>
      <section className="panel">
        <h2>Подключить браузер</h2>
        <ol className="flow-list">
          <li>Установите собранное расширение Manyvo в Яндекс Браузер.</li>
          <li>
            Создайте код подключения и вставьте его в настройки расширения.
          </li>
          <li>
            Укажите адрес этого сайта:{" "}
            <code>
              {typeof window !== "undefined" ? window.location.origin : ""}
            </code>
            .
          </li>
          <li>
            Нажмите «Проверить уведомление». Разрешите уведомления браузеру в
            настройках операционной системы.
          </li>
        </ol>
        <button className="button" disabled={busy} onClick={create}>
          Создать код подключения
        </button>
        {token && (
          <div className="connection-token">
            <label>
              Код доступа к вашему аккаунту
              <input
                readOnly
                value={token}
                aria-label="Код подключения расширения"
                onFocus={(e) => e.target.select()}
              />
            </label>
            <p className="field-help">
              Показывается один раз. Действует 30 дней. Вставляйте только в
              расширение Manyvo.
            </p>
            <button
              className="button secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(token);
                  flash("Код скопирован");
                } catch {
                  flash("Выделите и скопируйте код вручную");
                }
              }}
            >
              Скопировать
            </button>
          </div>
        )}
      </section>
      <section className="panel">
        <h2>Подключённые устройства</h2>
        {devices.map((d) => (
          <div className="device-row" key={d.id}>
            <div>
              <h3>{d.name}</h3>
              <p className="small muted">
                {d.revoked_at
                  ? "Доступ отозван"
                  : d.expires_at < Date.now() / 1000
                    ? "Срок доступа истёк"
                    : "Доступ до " + date(d.expires_at)}
                {d.last_seen ? " · Было подключение " + date(d.last_seen) : ""}
              </p>
            </div>
            {!d.revoked_at && (
              <button className="button secondary" onClick={() => revoke(d.id)}>
                Отключить
              </button>
            )}
          </div>
        ))}
        {!devices.length && (
          <p className="small muted">
            После подключения здесь появится устройство.
          </p>
        )}
      </section>
      <section className="panel">
        <h2>Проверка уведомления</h2>
        <p className="small muted">
          При работающем расширении уведомление придёт во время ближайшей
          проверки, обычно в течение минуты. При спящем компьютере доставка
          откладывается.
        </p>
        <button
          className="button secondary"
          onClick={async () => {
            try {
              await api("/notifications/test", "POST", {});
              flash("Тестовое уведомление создано. Проверьте расширение.");
            } catch (e) {
              flash(errorText(e));
            }
          }}
        >
          Проверить уведомление
        </button>
      </section>
    </>
  );
}
function ClaimCard({ claim }: { claim: Claim }) {
  return (
    <article className="claim-card">
      <div className="row spread">
        <h3>{claim.title}</h3>
        {claim.is_demo && <span className="pill">Демокупон</span>}
      </div>
      <p className="small muted">{claim.description}</p>
      <code className="coupon-code">{claim.code}</code>
      <p className="field-help">Получено {date(claim.created_at)}</p>
    </article>
  );
}
function RewardsView({
  data,
  user,
  refresh,
  flash,
}: Common & { data: Rewards }) {
  const [tab, setTab] = useState("wheel"),
    [claims, setClaims] = useState<Claim[]>([]),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<SpendResult | null>(null),
    [rotation, setRotation] = useState(0);
  useEffect(() => {
    api<{ claims: Claim[] }>("/rewards/claims")
      .then((r) => setClaims(r.claims))
      .catch((e) => flash(errorText(e)));
  }, [data, flash]);
  async function spend(reward?: Reward) {
    if (busy) return;
    const path = reward ? "/rewards/" + reward.id + "/redeem" : "/rewards/spin";
    const storageKey = "manyvo:" + user.id + ":" + path;
    let key = sessionStorage.getItem(storageKey);
    if (!key) {
      key = crypto.randomUUID();
      sessionStorage.setItem(storageKey, key);
    }
    setBusy(true);
    setResult(null);
    try {
      const r = await api<SpendResult>(path, "POST", { request_key: key });
      sessionStorage.removeItem(storageKey);
      if (!reward) {
        setRotation(
          (old) => Math.floor(old / 360) * 360 + 2160 - (r.sector * 90 + 45),
        );
        await new Promise((resolve) => setTimeout(resolve, 1800));
      }
      setResult(r);
      const mine = await api<{ claims: Claim[] }>("/rewards/claims");
      setClaims(mine.claims);
      flash(r.won ? "Награда получена" : "В этот раз без приза");
      refresh();
    } catch (e) {
      if (e instanceof APIError && e.status < 500)
        sessionStorage.removeItem(storageKey);
      flash(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  if (user.role === "owner")
    return <RewardAdmin data={data} refresh={refresh} flash={flash} />;
  return (
    <>
      <div className="row spread page-heading">
        <div>
          <h1>Награды за ваше мнение</h1>
          <p>Попробуйте удачу или копите на гарантированный приз.</p>
        </div>
        <span className="pill">Баланс: {data.balance}</span>
      </div>
      <div className="tabs reward-tabs">
        {[
          ["wheel", "Колесо призов"],
          ["guaranteed", "Гарантированные"],
          ["mine", "Мои награды"],
        ].map(([id, title]) => (
          <button
            className={"tab " + (tab === id ? "active" : "")}
            key={id}
            onClick={() => setTab(id)}
          >
            {title}
          </button>
        ))}
      </div>
      {tab === "wheel" && (
        <section className="panel wheel-layout">
          <div className="wheel-wrap">
            <span className="wheel-pointer" />
            <div
              className="prize-wheel"
              style={{ transform: `rotate(${rotation}deg)` }}
            >
              <span className="wheel-label one">Без приза</span>
              <span className="wheel-label two">Без приза</span>
              <span className="wheel-label three">Без приза</span>
              <span className="wheel-label four">Приз</span>
            </div>
            <div className="wheel-center">✳</div>
          </div>
          <div>
            <div className="eyebrow">Один небольшой шанс</div>
            <h2>Поверните колесо</h2>
            <p className="small muted">
              Прокрутка стоит {data.wheel.cost} балл. Четыре равновероятных
              сектора: три без приза, один с наградой. Шанс приза — 25%.
            </p>
            <h3>{data.wheel.prize?.title || "Приз ещё не добавлен"}</h3>
            {data.wheel.prize?.is_demo && (
              <div className="notice">
                Демонстрационный купон не имеет денежной стоимости.
              </div>
            )}
            <button
              className="button"
              disabled={
                busy || data.balance < data.wheel.cost || !data.wheel.available
              }
              onClick={() => spend()}
            >
              {busy
                ? "Колесо вращается…"
                : `Крутить за ${data.wheel.cost} балл`}
            </button>
            {!data.wheel.available && (
              <p className="field-help">
                Нет призовых кодов. Баллы не списываются.
              </p>
            )}
            {data.balance < data.wheel.cost && (
              <p className="field-help">
                Ответьте на исследование, чтобы получить баллы.
              </p>
            )}
          </div>
        </section>
      )}
      {tab === "guaranteed" && (
        <div className="study-grid">
          {data.rewards
            .filter((r) => r.channel === "guaranteed")
            .map((r) => (
              <article className="study-card" key={r.id}>
                <div className="row spread card-top">
                  <span className="pill">Гарантированная</span>
                  {r.is_demo && <span className="small muted">Демокупон</span>}
                </div>
                <h3>{r.title}</h3>
                <p>{r.description}</p>
                <div className="row spread card-bottom">
                  <strong>{r.cost} баллов</strong>
                  <span className="small muted">Осталось {r.stock}</span>
                </div>
                <button
                  className="button"
                  disabled={busy || r.stock === 0 || data.balance < r.cost}
                  onClick={() => spend(r)}
                >
                  {data.balance < r.cost
                    ? "Нужно ещё " + (r.cost - data.balance) + " баллов"
                    : "Получить награду"}
                </button>
              </article>
            ))}
        </div>
      )}
      {tab === "mine" && (
        <>
          {claims.map((c) => (
            <ClaimCard claim={c} key={c.id} />
          ))}
          {claims.length === 0 && (
            <Empty title="Ваши награды будут здесь">
              <p>Получите купон в колесе или обменяйте накопленные баллы.</p>
            </Empty>
          )}
        </>
      )}
      {result && (
        <section className="panel" aria-live="polite">
          <h2>
            {result.won ? "Поздравляем! Награда ваша." : "В этот раз без приза"}
          </h2>
          <p className="small muted">
            Списано {result.cost}. Остаток на момент операции: {result.balance}.
          </p>
          {result.claim && <ClaimCard claim={result.claim} />}
        </section>
      )}
    </>
  );
}
function RewardAdmin({
  data,
  refresh,
  flash,
}: {
  data: Rewards;
  refresh: () => void;
  flash: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false),
    [channel, setChannel] = useState("guaranteed");
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      d = new FormData(form);
    setBusy(true);
    try {
      await api("/rewards", "POST", {
        title: d.get("title"),
        description: d.get("description"),
        channel,
        cost: Number(d.get("cost")),
        is_demo: d.has("demo"),
        codes: String(d.get("codes"))
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      });
      form.reset();
      flash("Награда добавлена");
      refresh();
    } catch (e) {
      flash(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function codes(e: FormEvent<HTMLFormElement>, id: string) {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      await api("/rewards/" + id + "/codes", "POST", {
        codes: String(new FormData(form).get("codes"))
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      });
      form.reset();
      flash("Коды добавлены");
      refresh();
    } catch (e) {
      flash(errorText(e));
    }
  }
  return (
    <>
      <div className="page-heading">
        <h1>Награды участникам</h1>
        <p>Добавьте купоны, которые вы сможете предоставить участникам.</p>
      </div>
      <div className="notice">
        Купон выдаётся один раз и резервируется при обмене или выигрыше.
        Демокупоны нужно обозначать явно.
      </div>
      {data.rewards.map((r) => (
        <section className="panel" key={r.id}>
          <div className="row spread">
            <h2>{r.title}</h2>
            <span className="pill">
              {r.channel === "wheel" ? "Приз колеса" : r.cost + " баллов"}
              {r.is_demo ? " · Демо" : ""}
            </span>
          </div>
          <p className="small muted">
            {r.description} · Осталось {r.stock} ·{" "}
            {r.active ? "Доступна" : "Приостановлена"}
          </p>
          <form onSubmit={(e) => codes(e, r.id)}>
            <label>
              Дополнительные коды, каждый с новой строки
              <textarea name="codes" required placeholder="CODE-001" />
            </label>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="button secondary">Добавить коды</button>
              <button
                type="button"
                className="button ghost"
                onClick={async () => {
                  try {
                    await api("/rewards/" + r.id + "/status", "POST", {
                      active: !r.active,
                    });
                    refresh();
                  } catch (e) {
                    flash(errorText(e));
                  }
                }}
              >
                {r.active ? "Приостановить" : "Возобновить"}
              </button>
            </div>
          </form>
        </section>
      ))}
      <form className="panel" onSubmit={create}>
        <h2>Добавить награду</h2>
        <div className="form-grid">
          <label>
            Название
            <input name="title" maxLength={120} required />
          </label>
          <label>
            Тип
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
            >
              <option value="guaranteed">Гарантированная</option>
              <option value="wheel">Приз колеса</option>
            </select>
          </label>
          <label>
            Стоимость гарантированного обмена
            <input
              name="cost"
              type="number"
              min={2}
              max={1000000}
              defaultValue={10}
              required
            />
          </label>
        </div>
        <label className="field" style={{ marginTop: 20 }}>
          Описание и условия
          <textarea name="description" maxLength={1000} required />
        </label>
        <label>
          Коды наград, каждый с новой строки
          <textarea name="codes" required />
        </label>
        <label className="check-label">
          <input type="checkbox" name="demo" defaultChecked />
          Демонстрационные купоны без денежной стоимости
        </label>
        <p className="field-help">
          Для колеса активен один призовой сектор. Перед заменой приостановите
          прежнюю награду.
        </p>
        <button className="button" disabled={busy}>
          Добавить награду
        </button>
      </form>
    </>
  );
}
