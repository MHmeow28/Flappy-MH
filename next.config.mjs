/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.rbxcdn.com",
      },
    ],
  },
};

export default nextConfig;
