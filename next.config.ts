import type { NextConfig } from "next";

const developmentEvalSource = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";

const nextConfig: NextConfig = {
  agentRules: false,
  poweredByHeader: false,
  turbopack: {
    root: process.cwd(),
  },
  async headers() {
    const securityHeaders = [
      {
        key: "Content-Security-Policy",
        value:
          `default-src 'self'; script-src 'self' 'unsafe-inline'${developmentEvalSource}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`,
      },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      {
        key: "Permissions-Policy",
        value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
      {
        key: "Strict-Transport-Security",
        value: "max-age=31536000; includeSubDomains",
      },
    ];

    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
      {
        source: "/reset-password",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "Pragma", value: "no-cache" },
        ],
      },
      {
        source: "/api/v1/cases/:caseId/documents/:documentId",
        headers: [{ key: "Content-Security-Policy", value: "sandbox" }],
      },
      {
        source: "/api/v1/cases/:caseId/reports/:reportId",
        headers: [{ key: "Content-Security-Policy", value: "sandbox" }],
      },
    ];
  },
};

export default nextConfig;
