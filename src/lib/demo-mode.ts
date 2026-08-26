import process from "node:process";

export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === "true";
}
