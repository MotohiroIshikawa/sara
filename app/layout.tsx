import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sara",
  description: "GPTS manager",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className="min-h-screen bg-white antialiased font-sans">{children}</body>
    </html>
  );
}
