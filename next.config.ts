import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Doppelte Effekte in der Entwicklung sichtbar machen: hilft, wenn ein
  // Fetch später versehentlich zweimal feuert.
  reactStrictMode: true,
  experimental: {
    // Uploads laufen über Route Handler, nicht über Server Actions. Das Limit
    // hier ist die Obergrenze, die der App Router für Request-Bodies annimmt;
    // die fachliche Grenze (20 MB, nur PDF) prüft app/api/ingest/route.ts.
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
