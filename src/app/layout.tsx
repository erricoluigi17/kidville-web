import type { Metadata } from "next";
import { Barlow_Condensed, Maven_Pro } from "next/font/google";
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="it"
      className={`${barlow.variable} ${maven.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
