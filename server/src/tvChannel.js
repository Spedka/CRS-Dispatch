// Holds a live WebSocket per connected TV/kiosk tab (usually just one, but
// broadcasts to all of them if more than one is ever open). Any local
// mutation (job/assignment/time-off/request change) pushes a "refresh"
// message here via notifyTv.js so an already-open /tv screen updates
// without anyone touching it. Uses the WebSocket Hibernation API so an idle
// overnight connection doesn't stay pinned (and billed) in memory.
export class TvChannel {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // Plain POST forwarded from notifyTv.js.
    const body = await request.json().catch(() => ({}));
    const reason = body?.reason ?? null;
    const sockets = this.state.getWebSockets();
    const message = JSON.stringify({ type: 'refresh', reason });
    for (const ws of sockets) {
      try {
        ws.send(message);
      } catch {
        // Socket already closed/broken -- the client reconnects on its own
        // and refetches on reconnect, so a dropped push here is harmless.
      }
    }
    return new Response(JSON.stringify({ ok: true, delivered: sockets.length }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  // Push-only channel -- the client never needs to send anything back.
  async webSocketMessage() {}
  async webSocketClose() {}
  async webSocketError() {}
}
