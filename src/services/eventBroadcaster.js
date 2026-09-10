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
   * Register a new SSE client connection
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

    const client = { res, req, connectedAt: Date.now() };
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
   * Broadcast an event to all connected clients
   */
  broadcast(eventType, payload = {}) {
    const data = JSON.stringify(payload);
    const message = `event: ${eventType}\ndata: ${data}\n\n`;

    for (const client of this.clients) {
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
