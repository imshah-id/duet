import type { NextConfig } from "next";

if (process.env.VERCEL) {
  for (const [name, protocol] of [
    ["NEXT_PUBLIC_API_URL", "https:"],
    ["NEXT_PUBLIC_WS_URL", "wss:"],
  ]) {
    const value = process.env[name];
    const url = value && URL.canParse(value) ? new URL(value) : null;
    if (
      !url ||
      url.protocol !== protocol ||
      url.username ||
      url.password ||
      !url.hostname.includes(".") ||
      url.hostname.endsWith(".local") ||
      url.hostname.endsWith(".localhost") ||
      /^[\d.]+$/.test(url.hostname) ||
      url.hostname.includes(":") ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        `${name} must be a public ${protocol}// endpoint without credentials, query parameters, or a fragment before deploying to Vercel.`,
      );
    }
  }
}

const config: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value:
              "camera=(), microphone=(), geolocation=(), display-capture=(self)",
          },
        ],
      },
    ];
  },
};
export default config;
