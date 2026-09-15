const db = require('../db');

class StorageReconciler {
  constructor() {
    this.intervalHandle = null;
    this.RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
  }

  /**
   * Run storage reconciliation across all user accounts
   */
  async runReconciliation() {
    try {
      console.log('[StorageReconciler] Starting periodic storage reconciliation...');
      const result = db.reconcileAllUserStorage();
      console.log(`[StorageReconciler] Storage reconciliation complete: Checked ${result.usersChecked} users, corrected ${result.updatedCount} accounts.`);
      return result;
    } catch (error) {
      console.error('[StorageReconciler] Reconciliation error:', error);
      return null;
    }
  }

  /**
   * Initialize scheduled background reconciliation
   */
  start() {
    if (this.intervalHandle) return;

    // Run initial reconciliation shortly after startup (after 5 seconds)
    setTimeout(() => {
      this.runReconciliation().catch(() => {});
    }, 5000);

    // Schedule 24h recurring interval
    this.intervalHandle = setInterval(() => {
      this.runReconciliation().catch(() => {});
    }, this.RECONCILE_INTERVAL_MS);

    if (this.intervalHandle.unref) {
      this.intervalHandle.unref();
    }
  }

  stop() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }
}

const storageReconciler = new StorageReconciler();
module.exports = storageReconciler;
