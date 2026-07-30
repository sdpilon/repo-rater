import { createDb } from "~/db/client";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} environment variable is required to run the dashboard — set it before running \`pnpm dev\`.`,
    );
  }
  return value;
}

export const db = createDb(requireEnv("DATABASE_URL"));
