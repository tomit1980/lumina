import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export for GitHub Pages (https://tomit1980.github.io/lumina/).
  output: "export",
  basePath: "/lumina",
  trailingSlash: true,
  images: { unoptimized: true },
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
