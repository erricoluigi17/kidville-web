import type { Metadata } from "next";
import { Barlow_Condensed, Maven_Pro } from "next/font/google";
import { cookies } from "next/headers";
import { readContrastCookie } from "@/lib/accessibility/cookie";
import { RootProviders } from "@/components/providers/RootProviders";
import "./globals.css";

const barlow = Barlow_Condensed({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
  variable: "--loaded-barlow",
});

const maven = Maven_Pro({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--loaded-maven",
});

export const metadata: Metadata = {
  title: "Kidville",
  description: "La tua scuola, sempre con te",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Alto contrasto da cookie, applicato server-side (no FOUC).
  const highContrast = readContrastCookie(await cookies());
  return (
    <html
      lang="it"
      data-contrast={highContrast ? "high" : undefined}
      className={`${barlow.variable} ${maven.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <RootProviders initialHighContrast={highContrast}>{children}</RootProviders>
      </body>
    </html>
  );
}
