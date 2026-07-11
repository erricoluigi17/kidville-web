import type { Metadata, Viewport } from "next";
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

// viewport-fit=cover DICHIARATO staticamente: l'append a runtime della shell
// nativa (native-shell.ts) veniva perso quando Next riconcilia i meta del
// <head> → env(safe-area-inset-*) restava 0 e la AppBar finiva sotto la
// status bar iOS. Sul web env() vale 0: nessun effetto.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
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
