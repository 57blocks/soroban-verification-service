// Public surface of the verification feature. Everything else here is internal — other features should go
// through these, not reach into `components/`, `hooks/`, or `utils/`.
export { verificationRoutes } from "./routes";
export { VerifyConsole } from "./components/VerifyConsole";
export type { VerifyConsoleProps } from "./components/VerifyConsole";
