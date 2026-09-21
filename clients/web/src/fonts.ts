/**
 * The console's two typefaces, self-hosted. Loading them from the foundry's CDN disclosed every visitor's IP
 * to a third party and was the console's only such request (retention-and-pseudonymisation design.md RP-4) —
 * which is why the BlockSmith palette arrived here without BlockSmith's own Google Fonts import.
 *
 * Imported as modules rather than `@import`ed from index.css so PostCSS ordering cannot silently drop them,
 * and subset by subset so the build emits only the faces the design names — `tailwind.config.js`'s `sans`
 * (Inter 400/500/600/700) and `mono` (JetBrains Mono 400/500, for hashes, commands and build logs).
 */
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/inter/latin-ext-400.css";
import "@fontsource/inter/latin-ext-500.css";
import "@fontsource/inter/latin-ext-600.css";
import "@fontsource/inter/latin-ext-700.css";

import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-ext-400.css";
import "@fontsource/jetbrains-mono/latin-ext-500.css";
