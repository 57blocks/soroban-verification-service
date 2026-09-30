import animate from "tailwindcss-animate";

/** @type {import('tailwindcss').Config} */

const ink = "#101828";
const accent = "#f5d35a";
const verifiedGreen = "#14783f";
const mismatchRed = "#a12222";

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: ink,
          hover: "#1d2939",
          raised: "#344054",
          soft: "#475467",
          label: "#475467",
          body: "#4a5565",
          value: "#344054",
          warm: "#667085",
          mute: "#6b7280",
        },

        // Never body text on white (under 2:1); `deep` is the text-safe member of the family.
        yellow: {
          DEFAULT: accent,
          soft: "#fbecb4",
          pale: "#fdf6dd",
          bright: "#f5c134",
          deep: "#a77d0e",
          shade: "#c9a227",
          dot: "#d9ad00",
        },

        surface: {
          DEFAULT: "#ffffff",
          alt: "#f6f7fb",
          hover: "#f1f3f9",
          hero: "#f8fafc",
          track: "#eef0f6",
          chip: "#f6f7fb",
        },

        line: {
          DEFAULT: "#e5e7eb",
          strong: "#d7dae1",
          hero: "#e5e7eb",
          soft: "#eceef2",
          mute: "#d5d8de",
          quiet: "#cdd1d9",
        },

        dark: {
          DEFAULT: ink,
          card: "#1b2537",
          line: "#2a3448",
          rule: "#1f2937",
          hover: "#1d2939",
          fg: "#f9fafb",
          cmd: "#e5e7eb",
          text: "#d0d5dd",
          dim: "#98a2b3",
          bright: "#ffffff",
        },

        success: {
          fg: verifiedGreen,
          strong: "#166534",
          surface: "#f4fbf6",
          badge: "#ecf8f0",
          line: "rgba(20, 120, 63, 0.35)",
          wash: "rgba(20, 120, 63, 0.12)",
          dot: verifiedGreen,
        },
        warning: {
          fg: "#7c4a03",
          ink: "#5f4a00",
          surface: "#fdf6dd",
          badge: "#fbf3d3",
          line: "rgba(245, 211, 90, 0.9)",
          dot: "#d9ad00",
        },
        danger: {
          fg: mismatchRed,
          strong: "#991b1b",
          mark: "#c0392b",
          surface: "#fff6f5",
          badge: "#fdeeee",
          line: "rgba(161, 34, 34, 0.35)",
          wash: "rgba(161, 34, 34, 0.1)",
          dot: mismatchRed,
        },
        neutral: {
          fg: "#4a5565",
          surface: "#eef0f6",
          badge: "#e8ebf2",
          line: "rgba(74, 85, 101, 0.35)",
          dot: "#6b7280",
        },
      },

      fontFamily: {
        sans: ["Inter", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SF Mono", "Menlo", "monospace"],
      },

      maxWidth: {
        shell: "1440px",
        console: "1120px",
      },

      backgroundImage: {
        "hero-spectrum":
          "linear-gradient(90deg, #d97706, #ea580c, #db2777, #7c3aed, #db2777, #ea580c, #d97706)",
      },

      keyframes: {
        "cursor-blink": {
          "0%": { opacity: "1" },
          "100%": { opacity: "0" },
        },
        "gradient-pan": {
          "0%": { backgroundPosition: "0% 50%" },
          "100%": { backgroundPosition: "200% 50%" },
        },
        "arrow-slide": {
          "0%": { transform: "translateX(0)", opacity: "1" },
          "45%": { transform: "translateX(150%)", opacity: "0" },
          "50%": { transform: "translateX(-150%)", opacity: "0" },
          "100%": { transform: "translateX(0)", opacity: "1" },
        },
        "flow-x": {
          "0%": { transform: "translateX(0)", opacity: "0" },
          "15%, 80%": { opacity: "1" },
          "100%": { transform: "translateX(26px)", opacity: "0" },
        },
        "flow-y": {
          "0%": { transform: "translateY(0)", opacity: "0" },
          "15%, 80%": { opacity: "1" },
          "100%": { transform: "translateY(13px)", opacity: "0" },
        },
        "flow-path": {
          "0%": { offsetDistance: "0%", opacity: "0" },
          "15%, 80%": { opacity: "1" },
          "100%": { offsetDistance: "100%", opacity: "0" },
        },
      },

      animation: {
        "cursor-blink":
          "cursor-blink 0.5s cubic-bezier(0.645, 0.045, 0.355, 1) infinite alternate",
        "gradient-pan": "gradient-pan 6s linear infinite",
        "arrow-slide": "arrow-slide 0.4s ease",
        "flow-x": "flow-x 1.5s linear infinite",
        "flow-y": "flow-y 1.5s linear infinite",
        "flow-path": "flow-path 1.5s linear infinite",
      },

      boxShadow: {
        panel: "0 1px 2px rgba(16, 24, 40, 0.04), 0 10px 30px rgba(16, 24, 40, 0.06)",
        dropdown: "0 18px 50px rgba(16, 24, 40, 0.12)",
        float: "0 12px 32px rgba(16, 24, 40, 0.3)",
        focus: `0 0 0 3px rgba(245, 211, 90, 0.45)`,
      },
    },
  },
  plugins: [animate],
};
