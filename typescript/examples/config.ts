import { readFileSync } from "node:fs";
import { HushClient } from "hushclient-sdk";

export function makeClient(): HushClient {
  return new HushClient({
    baseUrl: process.env.HUSHCLIENT_BASE_URL ?? "https://localhost",
    ca: process.env.HUSHCLIENT_CA_FILE ? readFileSync(process.env.HUSHCLIENT_CA_FILE) : undefined,
    verifyTls: process.env.HUSHCLIENT_INSECURE !== "1",
  });
}

