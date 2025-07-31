import { LiffProvider } from "./liff-provider";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <LiffProvider>
      {children}
    </LiffProvider>
  );
}