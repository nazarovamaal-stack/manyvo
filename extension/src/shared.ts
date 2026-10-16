export interface Connection {
  origin: string;
  token: string;
  enabled: boolean;
  userId?: string;
}
export interface User {
  id: string;
  name: string;
  balance: number;
  role: string;
}
export interface Notice {
  id: string;
  kind: string;
  title: string;
  body: string;
  study_id: string | null;
  created_at: number;
}
export interface Feed {
  user: User;
  available: {
    id: string;
    title: string;
    question: string;
    deadline: number;
  }[];
  notifications: Notice[];
}
export interface Option {
  id: string;
  text: string;
  image?: string;
  position: number;
}
export interface Study {
  id: string;
  title: string;
  question: string;
  status: string;
  options: Option[];
  my_answer: { personal_id: string; prediction_id: string } | null;
  points?: { base?: number; bonus?: number };
  personal_leaders?: string[];
  complete?: boolean;
}
export interface Reward {
  id: string;
  title: string;
  description: string;
  cost: number;
  channel: string;
  stock: number;
  is_demo: boolean;
}
export interface Claim {
  id: string;
  title: string;
  description: string;
  code: string;
  is_demo: boolean;
  created_at: number;
}
export interface Rewards {
  balance: number;
  rewards: Reward[];
  wheel: { cost: number; available: boolean; prize: Reward | null };
}
export interface SpendResult {
  won: boolean;
  claim: Claim | null;
  balance: number;
  cost: number;
  sector: number;
}
export class RequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export function originURL(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Укажите только адрес сайта, без пути.");
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    )
  )
    throw new Error("Нужен HTTPS. HTTP разрешён только для локального Manyvo.");
  return url.origin;
}
export async function connection(): Promise<Connection | null> {
  const s = await chrome.storage.local.get("connection");
  return (s.connection as Connection | undefined) || null;
}
export async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
  config?: Connection,
): Promise<T> {
  const c = config || (await connection());
  if (!c) throw new RequestError("Сначала подключите расширение.", 401);
  const origin = originURL(c.origin);
  if (!path.startsWith("/api/") || path.includes(".."))
    throw new Error("Неверный запрос.");
  const response = await fetch(origin + path, {
    method,
    credentials: "omit",
    signal: AbortSignal.timeout(20000),
    headers: {
      Authorization: "Bearer " + c.token,
      "Content-Type": "application/json",
      "X-Manyvo-Client": "extension",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new RequestError(data.error || "Ошибка Manyvo.", response.status);
  return data;
}
export function safeText(value: unknown) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
export function panelURL(studyId?: string) {
  return (
    chrome.runtime.getURL("panel.html") +
    (studyId ? "#study/" + encodeURIComponent(studyId) : "")
  );
}
