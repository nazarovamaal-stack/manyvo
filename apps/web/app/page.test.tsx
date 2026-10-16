import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import Manyvo from "./page";
import type { User, Study, Claim, Device } from "./types";
let authenticated = false,
  user: User,
  study: Study,
  devices: Device[] = [],
  claims: Claim[] = [],
  calls: { path: string; method: string; body: Record<string, unknown> }[] = [];
const reward = {
  id: "reward1",
  title: "Купон на кофе",
  description: "Тестовая награда",
  cost: 10,
  channel: "guaranteed",
  stock: 1,
  is_demo: true,
  active: true,
};
beforeEach(() => {
  window.history.replaceState(null, "", "/");
  sessionStorage.clear();
  authenticated = false;
  user = {
    id: "u",
    name: "Анна",
    email: "anna@test.local",
    role: "participant",
    age: 24,
    country: "Россия",
    balance: 10,
    csrf: "csrf",
  };
  study = {
    id: "s1",
    title: "Выбираем заголовок",
    question: "Что выберете вы?",
    status: "open",
    version: 2,
    quota: 5,
    count: 1,
    age_min: 18,
    age_max: 65,
    country: "Россия",
    created_at: 1,
    deadline: 2000000000,
    options: [
      { id: "a", text: "Вариант A", position: 0 },
      { id: "b", text: "Вариант B", position: 1 },
    ],
    my_answer: null,
  };
  devices = [];
  claims = [];
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, options?: RequestInit) => {
      const path = String(input).replace("/api", ""),
        method = options?.method || "GET",
        body = options?.body ? JSON.parse(String(options.body)) : {};
      calls.push({ path, method, body });
      let data: unknown = { ok: true },
        status = 200;
      if (path === "/config") data = { demo: true, demo_accounts: [] };
      else if (path === "/login" || path === "/register") {
        authenticated = true;
        if (path === "/register") {
          user = {
            ...user,
            name: body.name,
            role: body.role,
            email: body.email,
          };
        }
        data = { csrf: "csrf" };
      } else if (path === "/me") {
        data = authenticated ? user : { error: "Войдите" };
        status = authenticated ? 200 : 401;
      } else if (path === "/notifications")
        data = { notifications: [], unread: 0 };
      else if (path === "/studies" && method === "GET")
        data = { studies: [study] };
      else if (path === "/studies/s1" && method === "GET") data = study;
      else if (path === "/studies/s1/answer") {
        study = {
          ...study,
          my_answer: {
            personal_id: String(body.personal_id),
            prediction_id: String(body.prediction_id),
            accepted_at: 1,
          },
          points: { base: 1 },
        };
        data = study;
      } else if (path === "/devices" && method === "GET") data = { devices };
      else if (path === "/devices" && method === "POST") {
        devices = [
          {
            id: "device1",
            name: "Мой Яндекс Браузер",
            created_at: 1,
            expires_at: 2000000000,
            last_seen: null,
            revoked_at: null,
          },
        ];
        data = {
          id: "device1",
          token: "mvo_test_secret",
          expires_at: 2000000000,
        };
      } else if (path === "/rewards")
        data = {
          rewards: [reward],
          balance: user.balance,
          wheel: {
            cost: 1,
            available: false,
            prize: null,
            sectors: [],
            demo_economy: true,
          },
        };
      else if (path === "/rewards/claims") data = { claims };
      else if (path === "/rewards/reward1/redeem") {
        user = { ...user, balance: 0 };
        const claim = {
          id: "c1",
          title: reward.title,
          description: reward.description,
          code: "TEST-COUPON-ONE",
          is_demo: true,
          created_at: 1,
        };
        claims = [claim];
        data = {
          operation_id: "op1",
          request_key: body.request_key,
          kind: "redeem",
          cost: 10,
          balance: 0,
          sector: 3,
          won: true,
          claim,
        };
      } else {
        status = 404;
        data = { error: "Unknown " + path };
      }
      return {
        ok: status < 400,
        status,
        json: async () => structuredClone(data),
      } as Response;
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function navigate(path: string) {
  await act(async () => {
    window.location.hash = "#" + path;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}
test("guest signs in and opens the correct workspace", async () => {
  user.role = "owner";
  render(<Manyvo />);
  await screen.findByRole("heading", { name: "Рады видеть вас" });
  fireEvent.change(screen.getByLabelText("Электронная почта"), {
    target: { value: "owner@test.local" },
  });
  fireEvent.change(screen.getByLabelText("Пароль"), {
    target: { value: "test-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Войти в Manyvo" }));
  await screen.findByRole("heading", { name: "Мои исследования" });
  expect(calls.find((c) => c.path === "/login")?.body.email).toBe(
    "owner@test.local",
  );
});
test("new participant can register with a profile for audience matching", async () => {
  render(<Manyvo />);
  await screen.findByRole("heading", { name: "Рады видеть вас" });
  fireEvent.click(
    screen.getByRole("button", { name: "Нет аккаунта? Зарегистрироваться" }),
  );
  fireEvent.change(screen.getByLabelText("Имя"), {
    target: { value: "Новый участник" },
  });
  fireEvent.change(screen.getByLabelText("Электронная почта"), {
    target: { value: "new@test.local" },
  });
  fireEvent.change(screen.getByLabelText("Пароль"), {
    target: { value: "strong-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Создать аккаунт" }));
  await screen.findByRole("heading", { name: "Новый взгляд — ваш" });
  expect(calls.find((c) => c.path === "/register")?.body).toMatchObject({
    name: "Новый участник",
    role: "participant",
    age: 18,
    country: "Россия",
  });
});
test("participant submits both choices and sees the receipt", async () => {
  authenticated = true;
  render(<Manyvo />);
  await screen.findByRole("heading", { name: "Новый взгляд — ваш" });
  await navigate("/study/s1");
  await screen.findByRole("heading", { name: "Выбираем заголовок" });
  const radios = screen.getAllByRole("radio");
  fireEvent.click(radios[0]);
  fireEvent.click(radios[3]);
  fireEvent.click(screen.getByRole("button", { name: "Отправить два ответа" }));
  await screen.findByRole("heading", { name: "Спасибо за ваш выбор" });
  expect(calls.find((c) => c.path.endsWith("/answer"))?.body).toEqual({
    personal_id: "a",
    prediction_id: "b",
  });
});
test("open study does not render owner distributions", async () => {
  authenticated = true;
  user.role = "owner";
  render(<Manyvo />);
  await screen.findByRole("heading", { name: "Мои исследования" });
  await navigate("/study/s1");
  await screen.findByText(/Распределения появятся после закрытия/);
  expect(
    screen.queryByRole("heading", { name: "Личные предпочтения" }),
  ).toBeNull();
  expect(
    screen.queryByRole("heading", { name: "Добавить фактические данные" }),
  ).toBeNull();
});
test("creating a connection shows the token even after the device list refreshes", async () => {
  authenticated = true;
  render(<Manyvo />);
  await screen.findByRole("heading", { name: "Новый взгляд — ваш" });
  await navigate("/extension");
  await screen.findByRole("heading", { name: "Расширение Manyvo" });
  fireEvent.click(
    screen.getByRole("button", { name: "Создать код подключения" }),
  );
  await screen.findByDisplayValue("mvo_test_secret");
  await screen.findByRole("heading", { name: "Мой Яндекс Браузер" });
  expect(screen.getByDisplayValue("mvo_test_secret")).toBeTruthy();
});
test("redemption shows the issued coupon and retains it across the balance refresh", async () => {
  authenticated = true;
  render(<Manyvo />);
  await screen.findByRole("heading", { name: "Новый взгляд — ваш" });
  await navigate("/rewards");
  await screen.findByRole("heading", { name: "Награды за ваше мнение" });
  fireEvent.click(screen.getByRole("button", { name: "Гарантированные" }));
  fireEvent.click(screen.getByRole("button", { name: "Получить награду" }));
  await screen.findByText("TEST-COUPON-ONE");
  await waitFor(() =>
    expect(screen.getAllByText(/Баланс: 0/).length).toBeGreaterThan(0),
  );
  expect(screen.getByText("TEST-COUPON-ONE")).toBeTruthy();
  expect(
    calls.find((c) => c.path.endsWith("/redeem"))?.body.request_key,
  ).toBeTruthy();
});
