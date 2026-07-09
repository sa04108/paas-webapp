import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // dockerode/ws는 네이티브 Node API(net/tls 소켓 등)에 의존하므로 서버 컴포넌트
  // 번들링에서 제외하고 네이티브 require로 로드한다. better-sqlite3는 Next.js가
  // 기본 목록에 이미 포함하고 있지만 명시적으로 남겨 의도를 드러낸다.
  serverExternalPackages: ["better-sqlite3", "dockerode", "ws"],
};

export default nextConfig;
