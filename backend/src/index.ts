import app from './app';
import { env } from './config/env';
import { prisma } from './config/prisma';

const server = app.listen(env.PORT, () => {
  console.info(`🚀 Server running on http://localhost:${env.PORT} [${env.NODE_ENV}]`);
});

// Graceful shutdown
const shutdown = async (signal: string): Promise<void> => {
  console.info(`\n${signal} received — shutting down gracefully...`);
  server.close(async () => {
    await prisma.$disconnect();
    console.info('Server closed.');
    process.exit(0);
  });
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
