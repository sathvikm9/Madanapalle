import assert from "node:assert/strict";
import test from "node:test";
import { invalidateAgentAuthorization } from "./agent-settings.js";

test("an unauthorized collector is safely disconnected without touching protected captures", async () => {
  const storage = {
    agentToken: "stale-token",
    collectorCredentialVersion: 2,
    lastHeartbeatAt: "2026-10-20T12:00:00.000Z",
    enabled: true,
    captureOutbox: { protected: { clientCaptureId: "protected" } }
  };
  globalThis.chrome = {
    storage: {
      local: {
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
        },
        async set(values) { Object.assign(storage, values); }
      }
    }
  };

  await invalidateAgentAuthorization("Unauthorized");

  assert.equal(storage.agentToken, undefined);
  assert.equal(storage.collectorCredentialVersion, undefined);
  assert.equal(storage.enabled, false);
  assert.equal(storage.agentAuthorizationInvalid.message, "Unauthorized");
  assert.deepEqual(storage.captureOutbox, { protected: { clientCaptureId: "protected" } });
  delete globalThis.chrome;
});
