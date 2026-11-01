import { NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const api = new URL(
    process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000",
  );
  const socket = new URL(
    process.env.NEXT_PUBLIC_WS_URL ||
      `${api.protocol === "https:" ? "wss:" : "ws:"}//${api.host}`,
  ).origin;
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://www.youtube.com https://s.ytimg.com ${process.env.NODE_ENV === "development" ? "'unsafe-eval'" : ""}`,
    // GSAP and the YouTube player set inline styles; scripts still require a nonce.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://i.ytimg.com",
    "font-src 'self'",
    `connect-src 'self' ${api.origin} ${socket} ${process.env.NODE_ENV === "development" ? "ws://localhost:3000 ws://127.0.0.1:3000" : ""}`,
    "media-src 'self' https: blob:",
    "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.svg$).*)"],
};
