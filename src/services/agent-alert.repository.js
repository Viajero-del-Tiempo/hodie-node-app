export function createAgentAlertRepository({ db, collection = "agent_alerts" }) {
  return {
    async request(alert, { signal } = {}) {
      const ref = db.collection(collection).doc(alert.id);
      return db.runTransaction(async tx => {
        const commit = await prepareDurableAlert(tx, ref, alert);
        signal?.throwIfAborted();
        return commit();
      });
    },
  };
}
import { prepareDurableAlert } from "./agent-alert.service.js";

