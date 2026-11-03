import type { Config } from "tailwindcss";

/**
 * Tailwind-Grundkonfiguration: nur wo die Dateien liegen.
 * Design-Tokens (Farben, Radien) kommen im nächsten Schritt dazu.
 */
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
