import { createServer } from 'http';
import { app } from './app';
import { env } from './config/env';
import { pool } from './config/database';
import { startSocket } from './socket';

const server = createServer(app);
const io = startSocket(server);

async function start() {
  await pool.query('SELECT 1');
  server.listen(env.port, () => {
    console.log(`Eventmitra server running at http://localhost:${env.port}`);
  });
}

async function shutdown(signal: string) {
  console.log(`Received ${signal}; shutting down`);
  io.close();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

start().catch(async (error) => {
  console.error('Failed to start server:', error);
  io.close();
  await pool.end();
  process.exitCode = 1;
});
