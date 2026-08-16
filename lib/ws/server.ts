// Localhost-only ws server the worker process pushes live events through.
// No auth - this is a single-local-user tool and the server never binds to
// anything but 127.0.0.1.
import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '../logger';

export class WorkerWsServer {
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();

  constructor(port: number) {
    this.wss = new WebSocketServer({ host: '127.0.0.1', port });
    this.wss.on('connection', (socket) => {
      this.clients.add(socket);
      socket.on('close', () => this.clients.delete(socket));
      socket.on('error', () => this.clients.delete(socket));
    });
    this.wss.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        logger.error({ port }, `Port ${port} is already in use - another worker is likely already running. Refusing to continue.`);
        process.exit(1);
      }
      logger.error({ error: String(error) }, 'Worker ws server error');
    });
    logger.info({ port }, 'Worker ws server listening on 127.0.0.1');
  }

  broadcast(event: string, payload: unknown) {
    const message = JSON.stringify({ event, payload });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  close() {
    for (const client of this.clients) client.terminate();
    this.wss.close();
  }
}
