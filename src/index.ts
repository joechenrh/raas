import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { initDatabase } from './db.js';
import { GitHubClient } from './github.js';
import { startScanner } from './scanner.js';
import { registerDashboard } from './dashboard.js';
import { initRepos } from './repos.js';

async function main() {
  console.log('Starting RaaS - Review as a Service');

  const config = loadConfig();
  console.log(`Config: port=${config.server.port}, repos=[${config.monitor.repos.join(', ')}], users=[${config.monitor.users.join(', ')}]`);

  const database = initDatabase();
  console.log('Database initialized');

  const github = new GitHubClient(config.github.token);
  try {
    const botUser = await github.getBotUser();
    console.log(`GitHub authenticated as: ${botUser}`);
  } catch (err: any) {
    console.error(`GitHub authentication failed: ${err.message}`);
    console.error('Set GITHUB_TOKEN env var with a valid token');
    process.exit(1);
  }

  // Clone/update all monitored repos locally
  if (config.monitor.repos.length > 0) {
    console.log('Initializing local repo clones...');
    await initRepos(config.monitor.repos, config.github.token);
    console.log('Repos ready');
  }

  const app = new Hono();
  registerDashboard(app, database, config);

  const scannerInterval = startScanner(config, database, github);

  const shutdown = () => {
    console.log('Shutting down...');
    clearInterval(scannerInterval);
    database.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log(`Server listening on http://0.0.0.0:${config.server.port}`);
  serve({
    fetch: app.fetch.bind(app),
    port: config.server.port,
    hostname: '0.0.0.0',
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
