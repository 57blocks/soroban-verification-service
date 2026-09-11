/**
 * The console's two typefaces, self-hosted. Loading them from Google disclosed every visitor's IP to
 * Google and was the console's only third-party request (retention-and-pseudonymisation design.md RP-4).
 *
 * Imported as modules rather than `@import`ed from index.css so PostCSS ordering cannot silently drop them,
 * and subset by subset so the build emits only the faces the design names — `tailwind.config.js`'s `sans`
 * (Inter 400/500/600/700) and `display` (Lora 400/500/600, italic 400/500).
 */
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/inter/latin-ext-400.css";
import "@fontsource/inter/latin-ext-500.css";
import "@fontsource/inter/latin-ext-600.css";
import "@fontsource/inter/latin-ext-700.css";

import "@fontsource/lora/latin-400.css";
import "@fontsource/lora/latin-500.css";
import "@fontsource/lora/latin-600.css";
import "@fontsource/lora/latin-400-italic.css";
import "@fontsource/lora/latin-500-italic.css";
import "@fontsource/lora/latin-ext-400.css";
import "@fontsource/lora/latin-ext-500.css";
import "@fontsource/lora/latin-ext-600.css";
import "@fontsource/lora/latin-ext-400-italic.css";
import "@fontsource/lora/latin-ext-500-italic.css";
