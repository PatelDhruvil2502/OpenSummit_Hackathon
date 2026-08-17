import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { publicAppOrigin } from "@/lib/runtime-flags";
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
  "An evidence-grounded AI auditor for H-1B workers: models propose and verify cited facts, people confirm them, and transparent code performs every comparison.";

export function generateMetadata(): Metadata {
  // The production origin comes from a trusted environment value, never the
  // request Host header. Render supplies RENDER_EXTERNAL_URL during builds;
  // PUBLIC_APP_URL takes precedence after a custom domain is attached.
  const origin = new URL(publicAppOrigin() ?? "http://localhost:3000");
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
