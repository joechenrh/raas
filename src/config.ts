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
    triage_token: string;
  };
  monitor: {
    users: string[];
    repos: string[];
    scan_interval_seconds: number;
    followup_enabled: boolean;
    ignore_before?: string;  // ISO date string — skip PRs created before this time
  };
  reviewer: {
    command: string;
    args: string[];
    max_concurrent: number;
    timeout_seconds: number;
    review_prompt: string;
    followup_prompt: string;
    triage_prompt: string;
  };
  debug: {
    enabled: boolean;
    prs: DebugPR[];       // only process these PRs
    dry_run: boolean;     // skip codex invocation, just log
    skip_scan_interval: boolean; // run once then stop scanning
  };
}

function normalizeStringList(value: unknown, fieldName: string): string[] {
  if (value == null) {
    return [];
  }

  const flattened = (Array.isArray(value) ? value.flat(Infinity) : [value]) as unknown[];

  return flattened.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new Error(`Invalid ${fieldName}[${index}]: expected a string, got ${typeof entry}.`);
    }
    return entry.trim();
  }).filter((entry) => entry.length > 0);
}

const DEFAULT_REVIEW_PROMPT = `Invoke skill \`pr-review\` with pr_link={pr_link} and project_path={project_path}.
Return the orchestration status JSON after the skill finishes.`;

const DEFAULT_TRIAGE_PROMPT = `Invoke skill \`dont-retest\` with pr_link={pr_link}.
Generate a CI failure triage report only — do not take automated actions.
Post the triage report as a PR comment on {pr_link}.
Return a JSON status summary after the skill finishes.`;

const DEFAULT_FOLLOWUP_PROMPT = `You are following up on your code review for PR #{number} in repository {repo}.

The local repository checkout is at:
- \`project_path={project_path}\`

You have full access to read all source files for context.

The authenticated review bot login for this run is:
- \`{reviewer_login}\`

Only process the exact follow-up targets below. Ignore every other PR comment or thread, even if the PR author replied there.

\`\`\`json
{followup_targets_json}
\`\`\`

Steps:
1. Use \`gh api repos/{repo}/pulls/{number}/comments\` to fetch review comments
2. Restrict work to the target entries listed above:
   - root review comment id = \`parentCommentId\`
   - author reply comment id = \`replyCommentId\`
   - root review comment author must match \`{reviewer_login}\`
3. If the target list is empty, exit without posting or resolving anything.
4. Read the relevant source files for context if needed
5. For each listed target:
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
      triage_token: process.env.GITHUB_TRIAGE_TOKEN || parsed.github?.triage_token || token,
    },
    monitor: {
      users: normalizeStringList(parsed.monitor?.users, 'monitor.users'),
      repos: normalizeStringList(parsed.monitor?.repos, 'monitor.repos'),
      scan_interval_seconds: parsed.monitor?.scan_interval_seconds || 60,
      followup_enabled: parsed.monitor?.followup_enabled ?? true,
      ignore_before: parsed.monitor?.ignore_before || new Date().toISOString(),
    },
    reviewer: {
      command: parsed.reviewer?.command || 'codex',
      args: parsed.reviewer?.args || ['exec', '--full-auto'],
      max_concurrent: parsed.reviewer?.max_concurrent || 1,
      timeout_seconds: parsed.reviewer?.timeout_seconds || 600,
      review_prompt: parsed.reviewer?.review_prompt || DEFAULT_REVIEW_PROMPT,
      followup_prompt: parsed.reviewer?.followup_prompt || DEFAULT_FOLLOWUP_PROMPT,
      triage_prompt: parsed.reviewer?.triage_prompt || DEFAULT_TRIAGE_PROMPT,
    },
    debug: {
      enabled: parsed.debug?.enabled ?? false,
      prs: rawDebugPRs,
      dry_run: parsed.debug?.dry_run ?? false,
      skip_scan_interval: parsed.debug?.skip_scan_interval ?? false,
    },
  };
}
