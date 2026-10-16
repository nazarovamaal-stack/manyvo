import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Manyvo — выбор, прогноз, результат",
  description: "Прогнозные микроисследования для бизнеса",
};
export default function Layout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
