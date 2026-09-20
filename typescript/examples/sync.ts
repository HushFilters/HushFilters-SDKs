import { makeClient } from "./config.js";

const client = makeClient();
const schedule = await client.autoUpdateStatus();
console.log("Schedule:", { enabled: schedule.enabled, hour: schedule.hour,
  timezone: schedule.timezone, next_update_at: schedule.next_update_at });
if (process.argv.includes("--apply")) {
  console.log("Accepted:", await client.syncApply());
  const final = await client.waitForSync({ timeoutMs: 7_200_000 });
  console.log("Completed:", { success: final.success, filter_count: final.filter_count, detail: final.detail });
} else {
  const status = await client.syncStatus();
  console.log("Latest sync:", { active: status.active, operation: status.operation, success: status.success });
}

