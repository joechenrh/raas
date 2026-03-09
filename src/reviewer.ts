import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { prepareForReview, getRepoDir } from './repos.js';

const LOGS_DIR = path.join(process.cwd(), 'logs', 'reviews');

export interface ReviewResult {
  exitCode: number;
  logFile: string;
  durationMs: number;
}

function ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

function buildPrompt(template: string, vars: Record<string, string | number>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, String(value));
  }
  return result;
}

export async function runCodexReview(
  config: Config,
  type: 'initial' | 'followup' | 'recheck',
  vars: { repo: string; number: number; title: string; author: string },
): Promise<ReviewResult> {
  const template = type === 'initial' || type === 'recheck' ? config.reviewer.review_prompt : config.reviewer.followup_prompt;
  const prompt = buildPrompt(template, vars);

  // Prepare local repo: fetch & checkout the PR branch
  let cwd: string;
  try {
    cwd = await prepareForReview(vars.repo, vars.number);
    console.log(`[reviewer] Repo prepared at: ${cwd}`);
  } catch (err: any) {
    console.error(`[reviewer] Failed to prepare repo: ${err.message}`);
    cwd = getRepoDir(vars.repo);
  }

  // Create log file for this review
  ensureLogsDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeRepo = vars.repo.replace('/', '_');
  const logFileName = `${safeRepo}_${vars.number}_${type}_${timestamp}.log`;
  const logFilePath = path.join(LOGS_DIR, logFileName);

  const startTime = Date.now();
  const args = [...config.reviewer.args, prompt];

  // Write header to log file
  const header = [
    `=== RaaS Review Log ===`,
    `Time: ${new Date().toISOString()}`,
    `Repo: ${vars.repo}`,
    `PR: #${vars.number}`,
    `Title: ${vars.title}`,
    `Author: ${vars.author}`,
    `Type: ${type}`,
    `Command: ${config.reviewer.command} ${config.reviewer.args.join(' ')}`,
    `Working directory: ${cwd}`,
    `${'='.repeat(40)}`,
    '',
  ].join('\n');
  fs.writeFileSync(logFilePath, header);

  console.log(`[reviewer] Spawning: ${config.reviewer.command} ${config.reviewer.args.join(' ')} "<prompt>"`);
  console.log(`[reviewer] Log file: ${logFilePath}`);

  return new Promise((resolve) => {
    const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

    const child = spawn(config.reviewer.command, args, {
      cwd,
      env: { ...process.env, GITHUB_TOKEN: config.github.token },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: config.reviewer.timeout_seconds * 1000,
    });

    if (child.stdout) child.stdout.pipe(logStream, { end: false });
    if (child.stderr) child.stderr.pipe(logStream, { end: false });

    let finished = false;
    function finish(footer: string, exitCode: number) {
      if (finished) return;
      finished = true;
      const duration = Date.now() - startTime;
      logStream.write(`\n${'='.repeat(40)}\n${footer}\nDuration: ${duration}ms\n`);
      logStream.end(() => {
        resolve({ exitCode, logFile: logFilePath, durationMs: duration });
      });
    }

    child.on('close', (code) => {
      finish(`Exit code: ${code}`, code ?? 1);
    });

    child.on('error', (err) => {
      finish(`Error: ${err.message}`, 1);
    });
  });
}
