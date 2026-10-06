import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Sitspot",
    short_name: "Sitspot",
    description: "Your places, calling you.",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f3ec",
    theme_color: "#2f6b4f",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
