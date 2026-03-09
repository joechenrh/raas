import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

export interface DebugPR {
  repo: string;   // "owner/repo"
  number: number;
}

export interface Config {
  server: {
    port: number;
  };
  github: {
    token: string;
  };
  monitor: {
    users: string[];
    repos: string[];
    scan_interval_seconds: number;
  };
  reviewer: {
    command: string;
    args: string[];
    max_concurrent: number;
    timeout_seconds: number;
    review_prompt: string;
    followup_prompt: string;
  };
  debug: {
    enabled: boolean;
    prs: DebugPR[];       // only process these PRs
    dry_run: boolean;     // skip codex invocation, just log
    skip_scan_interval: boolean; // run once then stop scanning
  };
}

const DEFAULT_REVIEW_PROMPT = `You are reviewing Pull Request #{number} in the repository {repo}.
PR Title: {title}
PR Author: {author}

You are currently in the local checkout of this repo with the PR branch checked out.
You have full access to read all source files in this repository for context.

Steps:
1. Run \`gh pr diff {number} -R {repo}\` to see the exact changes
2. Read the changed files in full to understand the surrounding context
3. Analyze the changes carefully with deep thinking
4. For each issue found, post a review comment using:
   gh pr review {number} -R {repo} --comment --body "Your detailed review"
5. For specific line issues, use inline review comments via \`gh api\`
6. If no significant issues, approve the PR

Focus on: bugs, security issues, performance problems, code quality.
Be constructive and specific. Read related files to understand the full context.`;

const DEFAULT_FOLLOWUP_PROMPT = `You are following up on your code review for PR #{number} in repository {repo}.

You are currently in the local checkout of this repo with the PR branch checked out.
You have full access to read all source files for context.

Steps:
1. Use \`gh api repos/{repo}/pulls/{number}/comments\` to fetch review comments
2. Find threads where the PR author replied to your review
3. Read the relevant source files for context if needed
4. For each reply:
   a. If the concern is adequately addressed, resolve the review thread
   b. If not, post a follow-up comment explaining what still needs work`;

export function loadConfig(configPath?: string): Config {
  const p = configPath || path.join(process.cwd(), 'config.yaml');

  let parsed: Record<string, any> = {};
  if (fs.existsSync(p)) {
    const raw = fs.readFileSync(p, 'utf-8');
    parsed = (yaml.load(raw) as Record<string, any>) || {};
  }

  let token = process.env.GITHUB_TOKEN || parsed.github?.token || '';
  if (!token) {
    try {
      token = execFileSync('gh', ['auth', 'token'], { timeout: 5000 }).toString().trim();
      console.log('[config] Using token from `gh auth token`');
    } catch {
      console.warn('[config] WARNING: GITHUB_TOKEN not set and `gh auth token` failed. GitHub API calls will fail.');
    }
  }

  // Parse debug.prs — accept either "owner/repo#123" strings or {repo, number} objects
  const rawDebugPRs: DebugPR[] = (parsed.debug?.prs || []).map((entry: any) => {
    if (typeof entry === 'string') {
      // "owner/repo#123"
      const match = entry.match(/^(.+)#(\d+)$/);
      if (match) return { repo: match[1], number: parseInt(match[2], 10) };
      throw new Error(`Invalid debug PR format: "${entry}". Use "owner/repo#123".`);
    }
    return { repo: entry.repo, number: entry.number };
  });

  return {
    server: {
      port: parsed.server?.port || Number(process.env.PORT) || 8080,
    },
    github: {
      token,
    },
    monitor: {
      users: parsed.monitor?.users || [],
      repos: parsed.monitor?.repos || [],
      scan_interval_seconds: parsed.monitor?.scan_interval_seconds || 60,
    },
    reviewer: {
      command: parsed.reviewer?.command || 'codex',
      args: parsed.reviewer?.args || ['exec', '--full-auto'],
      max_concurrent: parsed.reviewer?.max_concurrent || 1,
      timeout_seconds: parsed.reviewer?.timeout_seconds || 600,
      review_prompt: parsed.reviewer?.review_prompt || DEFAULT_REVIEW_PROMPT,
      followup_prompt: parsed.reviewer?.followup_prompt || DEFAULT_FOLLOWUP_PROMPT,
    },
    debug: {
      enabled: parsed.debug?.enabled ?? false,
      prs: rawDebugPRs,
      dry_run: parsed.debug?.dry_run ?? false,
      skip_scan_interval: parsed.debug?.skip_scan_interval ?? false,
    },
  };
}
