import animate from "tailwindcss-animate";

/** @type {import('tailwindcss').Config} */

// The single definition of the product's design tokens. The palette and type are BlockSmith's, the brand this
// service is hosted alongside. Group names are the app's own and describe what a value is *for*, so a component
// reads the same as it did before the values changed — see clients/web/README.md's "Design tokens".

// Values that belong to more than one group, hoisted so they cannot diverge.
const ink = "#101828";
const accent = "#f5d35a";
const verifiedGreen = "#14783f";
const mismatchRed = "#a12222";

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // Neutral scale, darkest to lightest. `ink` is BlockSmith's near-black, used for every heading, the
        // logo mark, solid buttons, and both dark sections.
        ink: {
          DEFAULT: ink,
          hover: "#1d2939", // solid-button hover
          raised: "#344054", // console pill hover
          soft: "#475467", // section eyebrow on light backgrounds
          label: "#475467", // panel sub-headings
          body: "#4a5565", // body copy — BlockSmith's `secondary`
          value: "#344054", // diagnostics + recent-job values
          warm: "#667085", // ghost buttons, and the recent-jobs timestamps
          mute: "#6b7280", // footer/meta text — BlockSmith's `secondary.light`
        },

        // The one accent. Never body text on white — at #f5d35a that is under 2:1; `deep` is the text-safe
        // member of the family, and the rest are fills.
        yellow: {
          DEFAULT: accent,
          soft: "#fbecb4",
          pale: "#fdf6dd", // dropdown/hover wash
          bright: "#f5c134", // CTA hover
          deep: "#a77d0e", // card eyebrow text on light backgrounds
          shade: "#c9a227", // the ◆ glyph's 1px text-shadow in the trust strip
          dot: "#d9ad00", // queued status dot
        },

        // Light surfaces, in the order they stack: page white → tinted → hover → hero wash.
        surface: {
          DEFAULT: "#ffffff",
          alt: "#f6f7fb", // tinted section + console page background — BlockSmith's `mist`
          hover: "#f1f3f9", // card hover on light sections
          hero: "#f8fafc", // landing hero wash
          track: "#eef0f6", // segmented control track
          chip: "#f6f7fb", // pill chips
        },

        line: {
          DEFAULT: "#e5e7eb", // BlockSmith's one border colour
          strong: "#d7dae1", // console borders + inputs
          hero: "#e5e7eb", // hero bottom rule
          soft: "#eceef2", // flow-progress track
          mute: "#d5d8de", // upcoming flow-step circle
          quiet: "#cdd1d9", // underlined "coming soon" labels
        },

        // The dark sections (the closing CTA) and their cards.
        dark: {
          DEFAULT: ink,
          card: "#1b2537",
          line: "#2a3448",
          rule: "#1f2937", // list dividers inside a dark card
          hover: "#1d2939",
          fg: "#f9fafb", // dark section body colour
          cmd: "#e5e7eb", // self-host command text
          text: "#d0d5dd", // dark card list items
          dim: "#98a2b3", // dark section blurb
          bright: "#ffffff", // dark section headings
        },

        // Verdict tones — restated in this palette, not dropped into it: each `fg` clears AA on its own
        // surface, because a mismatch has to keep reading as a mismatch. Within a group: `fg` is text,
        // `surface` the panel fill, `badge` the pill fill in the recent-jobs list, `dot` that list's status
        // dot.
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
          ink: "#5f4a00", // body text inside the yellow panels, where `fg` is too light
          surface: "#fdf6dd",
          badge: "#fbf3d3",
          line: "rgba(245, 211, 90, 0.9)",
          dot: "#d9ad00",
        },
        danger: {
          fg: mismatchRed,
          strong: "#991b1b",
          mark: "#c0392b", // the required-field asterisk
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
        // Inter is the UI font and the only one headings use — weight and size carry the hierarchy a display
        // serif used to. JetBrains Mono is BlockSmith's code face; both are self-hosted (src/fonts.ts).
        sans: ["Inter", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SF Mono", "Menlo", "monospace"],
      },

      maxWidth: {
        // BlockSmith's page width, and the console's narrower column. `console` was sized for a form beside a
        // decorative field that no longer exists; at 900px on a 1360px page it left void either side while the
        // two-up rows inside it crowded. 1120px is what the console's own widest content needs: two columns of
        // result evidence, and a 64-character digest comparison on one line.
        shell: "1440px",
        console: "1120px",
      },

      keyframes: {
        // The arrow inside a pill button slides out right and re-enters from the left on hover.
        "arrow-slide": {
          "0%": { transform: "translateX(0)", opacity: "1" },
          "45%": { transform: "translateX(150%)", opacity: "0" },
          "50%": { transform: "translateX(-150%)", opacity: "0" },
          "100%": { transform: "translateX(0)", opacity: "1" },
        },
        // The hero diagram's travelling dots: along a straight connector, and along a curved join.
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
        "arrow-slide": "arrow-slide 0.4s ease",
        "flow-x": "flow-x 1.5s linear infinite",
        "flow-y": "flow-y 1.5s linear infinite",
        "flow-path": "flow-path 1.5s linear infinite",
      },

      boxShadow: {
        // Every white panel and card floats on this one shadow; `lg` (Tailwind's own) is the hover state.
        panel: "0 1px 2px rgba(16, 24, 40, 0.04), 0 10px 30px rgba(16, 24, 40, 0.06)",
        dropdown: "0 18px 50px rgba(16, 24, 40, 0.12)",
        float: "0 12px 32px rgba(16, 24, 40, 0.3)",
        // The focus ring on every input.
        focus: `0 0 0 3px rgba(245, 211, 90, 0.45)`,
      },
    },
  },
  plugins: [animate],
};
