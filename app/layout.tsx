import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const SITE_TITLE = "WageShield H-1B | Evidence first. Human reviewed.";
const SITE_DESCRIPTION =
  "A privacy-first evidence auditor for H-1B workers that compares employment records using transparent, deterministic checks.";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const rawHost = (requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000")
    .split(",")[0]
    .trim();
  const host = /^[a-z0-9.-]+(?::\d+)?$/i.test(rawHost) ? rawHost : "localhost:3000";
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto")?.split(",")[0].trim();
  const protocol = forwardedProtocol === "https" || forwardedProtocol === "http"
    ? forwardedProtocol
    : host.startsWith("localhost")
      ? "http"
      : "https";
  const origin = new URL(`${protocol}://${host}`);
  const socialImage = new URL("/og-launch.png", origin).toString();

  return {
    metadataBase: origin,
    title: {
      default: SITE_TITLE,
      template: "%s | WageShield H-1B",
    },
    description: SITE_DESCRIPTION,
    icons: {
      icon: "/favicon.png",
      shortcut: "/favicon.png",
    },
    openGraph: {
      type: "website",
      url: origin.toString(),
      siteName: "WageShield H-1B",
      title: SITE_TITLE,
      description: SITE_DESCRIPTION,
      images: [{ url: socialImage, width: 1200, height: 630, alt: "WageShield H-1B evidence review" }],
    },
    twitter: {
      card: "summary_large_image",
      title: SITE_TITLE,
      description: SITE_DESCRIPTION,
      images: [socialImage],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <a className="skip-link" href="#application-content">
          Skip to page content
        </a>
        <div id="application-content" tabIndex={-1}>
          {children}
        </div>
      </body>
    </html>
  );
}
