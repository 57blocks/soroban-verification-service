import animate from "tailwindcss-animate";

/** @type {import('tailwindcss').Config} */

// The single definition of the product's design tokens, transcribed from the approved design (`index.html`,
// `verify-console.html`, `job-status.html`).

// Values that belong to more than one group, hoisted so they cannot diverge.
const stellarYellow = "#fdda24";
const stellarGreen = "#14783f";
const stellarRed = "#a12222";
const stellarBlack = "#0f0f0f";

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // Neutral scale, darkest to lightest. `ink` is the design's near-black (#0f0f0f), used for every
        // heading, every logo mark, and both dark sections.
        ink: {
          DEFAULT: stellarBlack,
          hover: "#262626", // landing pill hover
          raised: "#323232", // console pill hover
          soft: "#44423b", // section eyebrow on light backgrounds
          label: "#475467", // panel sub-headings
          body: "#55534c", // body copy
          value: "#344054", // diagnostics + recent-job values
          warm: "#77746a", // small uppercase captions in the console
          mute: "#8a877c", // footer/meta text
        },

        // The one accent. `pale` is the dropdown/hover wash, `bright` the CTA hover.
        yellow: {
          DEFAULT: stellarYellow,
          soft: "#fff4a4",
          pale: "#fff8bd",
          bright: "#ffe75c",
          deep: "#9b7f00", // card eyebrow text on light backgrounds
          shade: "#b89b00", // the ◆ glyph's 1px text-shadow in the trust strip
          dot: "#d9ad00", // queued status dot
        },

        // Light surfaces, in the order they stack: page white → tinted → hover → hero wash.
        surface: {
          DEFAULT: "#ffffff",
          alt: "#f1f1ef", // tinted section + console page background
          hover: "#f6f6f4", // card hover on light sections
          hero: "#fffdf3", // landing hero wash
          field: "#faf9f6", // available-metadata rows
          track: "#ebe8dd", // segmented control track
          chip: "#f1f1ef", // pill chips
        },

        line: {
          DEFAULT: "#e8e5da", // landing borders
          strong: "#dedbd0", // console borders + inputs
          hero: "#e0ddd0", // hero bottom rule
          soft: "#e3e1da", // flow-progress track
          mute: "#d5d3cc", // upcoming flow-step circle
          quiet: "#d4d1c4", // underlined "coming soon" labels
        },

        // The dark sections (architecture, closing CTA) and their cards.
        dark: {
          DEFAULT: stellarBlack,
          card: "#151513",
          line: "#2a2a26",
          rule: "#1f1f1c", // list dividers inside a dark card
          hover: "#1a1a18",
          fg: "#f5f5f5", // dark section body colour
          cmd: "#e5e5e5", // self-host command text
          text: "#c5c5c0", // dark card list items
          dim: "#b8b6ac", // dark section blurb
          bright: "#fafafa", // dark section headings
        },

        // Verdict tones. Within a group: `fg` is text, `surface` the panel fill, `badge` the pill fill in the
        // recent-jobs list, `dot` that list's status dot.
        success: {
          fg: stellarGreen,
          strong: "#166534",
          surface: "#f6fff3",
          badge: "#f0fbf2",
          line: "rgba(20, 120, 63, 0.35)",
          wash: "rgba(20, 120, 63, 0.12)",
          dot: stellarGreen,
        },
        warning: {
          fg: "#7c4a03",
          ink: "#5f5200", // body text inside the yellow panels, where `fg` is too light
          surface: "#fff9cc",
          badge: "#fff7d1",
          line: "rgba(253, 218, 36, 0.9)",
          dot: "#d9ad00",
        },
        danger: {
          fg: stellarRed,
          strong: "#991b1b",
          mark: "#c0392b", // the required-field asterisk
          surface: "#fff7f5",
          badge: "#fff0f0",
          line: "rgba(161, 34, 34, 0.35)",
          wash: "rgba(161, 34, 34, 0.1)",
          dot: stellarRed,
        },
        neutral: {
          fg: "#3f4a5a",
          surface: "#eceef2",
          badge: "#e4e8ee",
          line: "rgba(71, 85, 105, 0.35)",
          dot: "#64748b",
        },
      },

      fontFamily: {
        // Inter is the UI font; Lora the display serif every heading in the design uses.
        sans: ["Inter", "-apple-system", "Segoe UI", "sans-serif"],
        display: ["Lora", "Georgia", "serif"],
        mono: ["ui-monospace", "SF Mono", "Menlo", "monospace"],
      },

      maxWidth: {
        // The design's one page width, and the console's narrower column.
        shell: "1320px",
        console: "900px",
      },

      boxShadow: {
        // Every white console panel floats on this one shadow.
        panel: "0 20px 60px rgba(15, 15, 15, 0.06)",
        dropdown: "0 18px 50px rgba(15, 15, 15, 0.12)",
        float: "0 12px 32px rgba(15, 15, 15, 0.3)",
        // The badge pill's yellow underline, and the focus ring on every input.
        underline: `inset 0 -2px 0 ${stellarYellow}`,
        focus: "0 0 0 3px rgba(253, 218, 36, 0.32)",
      },

      backgroundImage: {
        // The yellow dot field behind the hero and the console page.
        dots: `radial-gradient(circle at 4px 4px, rgba(253, 218, 36, 0.38) 0 2.6px, transparent 3.2px)`,
        "hero-glow":
          "radial-gradient(ellipse at center, rgba(255,255,255,0.95) 0 30%, rgba(255,255,255,0.55) 55%, rgba(255,255,255,0) 75%)",
        "cta-glow":
          "radial-gradient(800px 400px at 80% 50%, rgba(253,218,36,0.16), transparent 70%)",
        // The console page: the dot field, faded out from the top so the hero stays legible.
        "console-page":
          "linear-gradient(180deg, rgba(241,241,239,0) 0%, rgba(241,241,239,0.72) 340px, #f1f1ef 640px), radial-gradient(circle at 4px 4px, rgba(253,218,36,0.38) 0 2.6px, transparent 3.2px)",
      },

      // Named `dotgrid`, not `dots`: Tailwind derives both background-image and background-size utilities as
      // `bg-*`, so reusing the key would make one shadow the other.
      backgroundSize: {
        dotgrid: "13px 13px",
      },

      keyframes: {
        // The arrow inside a pill button slides out right and re-enters from the left on hover.
        "arrow-slide": {
          "0%": { transform: "translateX(0)", opacity: "1" },
          "45%": { transform: "translateX(150%)", opacity: "0" },
          "50%": { transform: "translateX(-150%)", opacity: "0" },
          "100%": { transform: "translateX(0)", opacity: "1" },
        },
        // The slow drifting light behind the hero.
        glow: {
          "0%": { transform: "translate(-25%, -20%) scale(1)" },
          "50%": { transform: "translate(40%, 22%) scale(1.15)" },
          "100%": { transform: "translate(-25%, -20%) scale(1)" },
        },
        // One character of the hero's rotating word arriving / leaving.
        "rotate-char-in": {
          "0%": { opacity: "0", transform: "translateY(0.85em)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "rotate-char-out": {
          "0%": { opacity: "1", transform: "translateY(0)" },
          "100%": { opacity: "0", transform: "translateY(-0.95em)" },
        },
      },

      animation: {
        "arrow-slide": "arrow-slide 0.4s ease",
        glow: "glow 14s ease-in-out infinite",
        // Durations must match ENTER_MS / EXIT_MS in components/ui/rotating-text.tsx — the component sequences
        // the two halves off those numbers.
        "rotate-char-in": "rotate-char-in 0.5s cubic-bezier(0.22, 1, 0.36, 1) both",
        "rotate-char-out": "rotate-char-out 0.4s cubic-bezier(0.4, 0, 1, 1) both",
      },
    },
  },
  plugins: [animate],
};
