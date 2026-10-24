import { Server } from 'socket.io';
import { Server as HttpServer } from 'http';
import { env } from '../config/env';

export function startSocket(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: { origin: env.corsOrigins.includes('*') ? '*' : env.corsOrigins },
  });
  io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);
    socket.on('disconnect', () => console.log('Socket disconnected:', socket.id));
  });
  // Authentication/authorization must be added before exposing private socket events.
  return io;
}
