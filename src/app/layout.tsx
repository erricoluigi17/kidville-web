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

/**
 * Base per gli URL assoluti dei metadata. Senza `metadataBase` Next emette percorsi
 * RELATIVI per l'anteprima social, e diversi scraper (WhatsApp fra questi) non li risolvono:
 * il risultato è un link condiviso senza immagine, che è esattamente il caso che questi
 * metadata esistono per risolvere. `NEXT_PUBLIC_APP_URL` è la stessa variabile già usata per
 * i link nelle email; il ripiego serve a build e anteprime, dove non è impostata.
 */
const BASE_URL = new URL(process.env.NEXT_PUBLIC_APP_URL ?? "https://app.kidville.it");

/**
 * L'immagine dell'anteprima è `src/app/opengraph-image.png`: Next la trova per convenzione
 * di nome e ne emette da sé i tag `og:image` / `twitter:image` con dimensioni e URL assoluto.
 * Stessa convenzione per `icon.png`, `apple-icon.png` e `favicon.ico` nella stessa cartella.
 * Tutte generate da `scripts/genera-icone.mjs`.
 */
export const metadata: Metadata = {
  metadataBase: BASE_URL,
  title: "Kidville",
  description: "La tua scuola, sempre con te",
  applicationName: "Kidville",
  openGraph: {
    type: "website",
    siteName: "Kidville",
    title: "Kidville",
    description: "La tua scuola, sempre con te",
    locale: "it_IT",
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: "Kidville",
    description: "La tua scuola, sempre con te",
  },
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
