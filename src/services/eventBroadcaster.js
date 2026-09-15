const EventEmitter = require('events');

/**
 * Real-Time Event Broadcaster using Server-Sent Events (SSE)
 * Synchronizes file/folder changes across all open browser tabs and devices in real time.
 */
class EventBroadcaster extends EventEmitter {
  constructor() {
    super();
    this.clients = new Set();
    
    // Heartbeat ping to keep connections alive through proxies, Nginx, and mobile firewalls
    setInterval(() => {
      this.sendHeartbeat();
    }, 20000).unref();
  }

  /**
   * Register a new SSE client connection (scoped to authenticated user)
   */
  addClient(res, req) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable proxy buffering (Nginx)
      'Access-Control-Allow-Origin': '*',
    });

    res.write(':connected\n\n');

    const userId = req.user ? String(req.user.id) : null;
    const client = { res, req, userId, connectedAt: Date.now() };
    this.clients.add(client);

    req.on('close', () => {
      this.clients.delete(client);
    });
  }

  /**
   * Send heartbeat comment
   */
  sendHeartbeat() {
    for (const client of this.clients) {
      try {
        client.res.write(':ping\n\n');
      } catch (e) {
        this.clients.delete(client);
      }
    }
  }

  /**
   * Broadcast an event strictly to authorized client(s)
   * If targetUserId or payload.userId/payload.file.user_id is present, NEVER deliver to other users!
   */
  broadcast(eventType, payload = {}, targetUserId = null) {
    const rawTargetUserId = targetUserId ||
      payload.userId ||
      (payload.file && payload.file.user_id) ||
      (payload.folder && payload.folder.user_id) ||
      null;

    const resolvedUserId = rawTargetUserId ? String(rawTargetUserId) : null;

    const data = JSON.stringify(payload);
    const message = `event: ${eventType}\ndata: ${data}\n\n`;

    for (const client of this.clients) {
      // MAXIMUM SECURITY: If this event is scoped to a specific user, NEVER send to other users!
      if (resolvedUserId) {
        if (!client.userId || client.userId !== resolvedUserId) {
          continue;
        }
      }

      try {
        client.res.write(message);
      } catch (e) {
        this.clients.delete(client);
      }
    }
  }

  /**
   * Get active connection count
   */
  getConnectionCount() {
    return this.clients.size;
  }
}

const eventBroadcaster = new EventBroadcaster();
module.exports = eventBroadcaster;
