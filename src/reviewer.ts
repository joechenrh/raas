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
  executionStatus?: string;
  executionReason?: string;
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

function normalizeReviewerArgs(args: string[]): string[] {
  const normalized = [...args];

  for (let i = 0; i < normalized.length - 1; i++) {
    const flag = normalized[i];
    const value = normalized[i + 1];
    if ((flag === '-a' || flag === '--ask-for-approval') && value === 'full-auto') {
      normalized.splice(i, 2, '--full-auto');
      break;
    }
  }

  const hasMultiAgent = normalized.some(
    (arg, index) => arg === '--enable' && normalized[index + 1] === 'multi_agent',
  );
  if (!hasMultiAgent) {
    normalized.push('--enable', 'multi_agent');
  }

  return normalized;
}

function hardenInitialReviewPrompt(prompt: string): string {
  return `${prompt.trim()}

Additional execution constraints:
1. If the orchestration uses \`codex exec\` reviewer child processes, each child process is already the required reviewer subagent.
2. Reviewer child processes must run the named skill directly in that same process.
3. Reviewer child processes must not call \`spawn_agent\`, \`collab\`, \`Task\`, or delegate to any additional subagents.
4. Keep reviewer child working directory at this repository root and grant the reviewed checkout via additional writable scope instead of switching child cwd there.
`;
}

function hasExplicitCodexCdArg(args: string[]): boolean {
  return args.includes('-C') || args.includes('--cd');
}

function extractExecutionSummary(logFilePath: string): { executionStatus?: string; executionReason?: string } {
  try {
    const content = fs.readFileSync(logFilePath, 'utf-8');
    const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.startsWith('{') || !line.endsWith('}')) {
        continue;
      }

      try {
        const payload = JSON.parse(line) as { status?: unknown; reason?: unknown };
        if (typeof payload.status === 'string') {
          return {
            executionStatus: payload.status,
            executionReason: typeof payload.reason === 'string' ? payload.reason : undefined,
          };
        }
      } catch {
        // Ignore non-JSON lines that happen to start/end with braces.
      }
    }
  } catch {
    // Ignore log read/parsing failures and fall back to exit-code-only handling.
  }

  return {};
}

export async function runCodexReview(
  config: Config,
  type: 'initial' | 'followup' | 'recheck',
  vars: { repo: string; number: number; title: string; author: string },
): Promise<ReviewResult> {
  const template = type === 'initial' || type === 'recheck' ? config.reviewer.review_prompt : config.reviewer.followup_prompt;

  // Prepare local repo: fetch & checkout the PR branch
  let projectPath: string;
  try {
    projectPath = await prepareForReview(vars.repo, vars.number);
    console.log(`[reviewer] Repo prepared at: ${projectPath}`);
  } catch (err: any) {
    console.error(`[reviewer] Failed to prepare repo: ${err.message}`);
    projectPath = getRepoDir(vars.repo);
  }

  const appRoot = process.cwd();
  const prLink = `https://github.com/${vars.repo}/pull/${vars.number}`;
  let prompt = buildPrompt(template, {
    ...vars,
    pr_link: prLink,
    project_path: projectPath,
  });
  if (type === 'initial' || type === 'recheck') {
    prompt = hardenInitialReviewPrompt(prompt);
  }
  const codexCwd = type === 'followup' ? projectPath : appRoot;

  // Create log file for this review
  ensureLogsDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeRepo = vars.repo.replace('/', '_');
  const logFileName = `${safeRepo}_${vars.number}_${type}_${timestamp}.log`;
  const logFilePath = path.join(LOGS_DIR, logFileName);

  const startTime = Date.now();
  const baseArgs = normalizeReviewerArgs(config.reviewer.args);
  if (!hasExplicitCodexCdArg(baseArgs)) {
    baseArgs.push('-C', codexCwd);
  }
  const args = [...baseArgs, prompt];

  // Write header to log file
  const header = [
    `=== RaaS Review Log ===`,
    `Time: ${new Date().toISOString()}`,
    `Repo: ${vars.repo}`,
    `PR: #${vars.number}`,
    `Title: ${vars.title}`,
    `Author: ${vars.author}`,
    `Type: ${type}`,
    `Command: ${config.reviewer.command} ${baseArgs.join(' ')}`,
    `Codex working directory: ${codexCwd}`,
    `Project path: ${projectPath}`,
    `PR link: ${prLink}`,
    `${'='.repeat(40)}`,
    '',
  ].join('\n');
  fs.writeFileSync(logFilePath, header);

  console.log(`[reviewer] Spawning: ${config.reviewer.command} ${baseArgs.join(' ')} "<prompt>"`);
  console.log(`[reviewer] Log file: ${logFilePath}`);

  return new Promise((resolve) => {
    const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

    const child = spawn(config.reviewer.command, args, {
      cwd: codexCwd,
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
        resolve({
          exitCode,
          logFile: logFilePath,
          durationMs: duration,
          ...extractExecutionSummary(logFilePath),
        });
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
