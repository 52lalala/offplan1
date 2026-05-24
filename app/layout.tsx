import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "在线休息申请协同系统",
  description: "面向小团队的实时休息申请与排班协同 MVP",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
