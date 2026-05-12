import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { Geist_Mono, Inter } from "next/font/google";
import { clerkLocalizationPtBr } from "@/lib/clerkLocalization";
import "./globals.css";
import "@/features/auth/styles/auth.css";
import "@/features/dashboard/styles/dashboard.css";
import "@/features/dashboard/styles/claude.css";

const inter = Inter({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Painel de Custos",
  description: "Frontend Next.js do Painel de Custos",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR" className={`${inter.variable} ${geistMono.variable}`}>
      <body>
        <ClerkProvider localization={clerkLocalizationPtBr}>{children}</ClerkProvider>
      </body>
    </html>
  );
}
