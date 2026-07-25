import type { Metadata, Viewport } from "next";
import { Barlow_Condensed, Maven_Pro } from "next/font/google";
import { cookies } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { readContrastCookie } from "@/lib/accessibility/cookie";
import { haCookieSessione } from "@/lib/auth/session-cookie";
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
  const cookieStore = await cookies();
  // Alto contrasto da cookie, applicato server-side (no FOUC).
  const highContrast = readContrastCookie(cookieStore);
  // Sessione presente? Serve SOLO al gate biometrico, per non armarsi sopra la
  // schermata di login. Non è un controllo di autorizzazione: quello resta al
  // middleware e ai gate applicativi.
  const autenticato = haCookieSessione(cookieStore);
  // Lingua + messaggi (next-intl, locale dal cookie KV_LOCALE; default it).
  const locale = await getLocale();
  const messages = await getMessages();
  return (
    <html
      lang={locale}
      data-contrast={highContrast ? "high" : undefined}
      className={`${barlow.variable} ${maven.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <NextIntlClientProvider messages={messages}>
          <RootProviders initialHighContrast={highContrast} autenticato={autenticato}>
            {children}
          </RootProviders>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
