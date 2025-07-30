import { LiffProvider } from "./liff-provider";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html>
      <body>
        <LiffProvider>
          {children}
        </LiffProvider>
      </body>
    </html>
  );
}
