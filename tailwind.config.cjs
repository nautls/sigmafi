/* eslint-disable no-undef */

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{vue,js,ts,jsx,tsx}", "!@oruga-ui/*"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        serif: ['"Newsreader"', "Georgia", "Cambria", "serif"],
        sans: ['"DM Sans"', "system-ui", "sans-serif"],
        mono: ['"IBM Plex Sans"', '"DM Sans"', "system-ui", "sans-serif"]
      },
      colors: {
        paper: {
          50: "#ffffff",
          100: "#faf9f5",
          200: "#f3f1ea",
          300: "#e8e4da"
        },
        ink: {
          950: "#0b0f14",
          900: "#111827",
          700: "#374151",
          500: "#64748b",
          400: "#94a3b8"
        },
        cobalt: {
          50: "rgb(var(--sf-cobalt-50) / <alpha-value>)",
          100: "rgb(var(--sf-cobalt-100) / <alpha-value>)",
          500: "#2563eb",
          600: "rgb(var(--sf-cobalt-600) / <alpha-value>)",
          700: "rgb(var(--sf-cobalt-700) / <alpha-value>)"
        }
      }
    }
  },
  plugins: [require("daisyui")],
  daisyui: {
    styled: true,
    themes: ["light", "dark"],
    base: true,
    utils: true,
    logs: false,
    darkTheme: "dark"
  }
};
