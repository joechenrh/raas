import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const exec = promisify(execFile);

const REPOS_DIR = path.join(process.cwd(), 'outputs', 'repos');
const SYNC_REVIEW_SKILLS_SCRIPT = path.join(process.cwd(), 'scripts', 'sync_repo_review_skills.sh');
let hasWarnedMissingSkillSyncScript = false;

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] [repos] ${msg}`);
}

function repoDir(owner: string, repo: string): string {
  return path.join(REPOS_DIR, owner, repo);
}

async function run(cmd: string, args: string[], cwd: string, timeout = 120_000): Promise<string> {
  const { stdout } = await exec(cmd, args, { cwd, timeout });
  return stdout.trim();
}

async function syncReviewSkills(targetPath: string): Promise<void> {
  if (!fs.existsSync(SYNC_REVIEW_SKILLS_SCRIPT)) {
    if (!hasWarnedMissingSkillSyncScript) {
      log(`Review skill sync script not found at ${SYNC_REVIEW_SKILLS_SCRIPT}; skipping repo-local skill sync`);
      hasWarnedMissingSkillSyncScript = true;
    }
    return;
  }
  await run('bash', [SYNC_REVIEW_SKILLS_SCRIPT, '--target', targetPath], process.cwd(), 120_000);
}

async function getDefaultBranch(dir: string): Promise<string> {
  try {
    const ref = await run('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], dir);
    return ref.replace('refs/remotes/origin/', '');
  } catch {
    // Fallback: try main, then master
    try {
      await run('git', ['rev-parse', '--verify', 'origin/main'], dir);
      return 'main';
    } catch {
      return 'master';
    }
  }
}

/**
 * Clone all configured repos at startup. Skip if already cloned.
 * Uses plain HTTPS URLs — auth is handled by git credential helper (gh auth setup-git).
 */
export async function initRepos(repos: string[], _token: string): Promise<void> {
  if (!fs.existsSync(REPOS_DIR)) {
    fs.mkdirSync(REPOS_DIR, { recursive: true });
  }

  for (const fullName of repos) {
    const [owner, repo] = fullName.split('/');
    const dir = repoDir(owner, repo);

    if (fs.existsSync(path.join(dir, '.git'))) {
      log(`Repo ${fullName} already cloned, updating...`);
      try {
        // Fix remote URL if it has an embedded token
        const remoteUrl = await run('git', ['remote', 'get-url', 'origin'], dir);
        if (remoteUrl.includes('x-access-token:')) {
          log(`Fixing remote URL for ${fullName} (removing embedded token)`);
          await run('git', ['remote', 'set-url', 'origin', `https://github.com/${fullName}.git`], dir);
        }

        const defaultBranch = await getDefaultBranch(dir);
        await run('git', ['checkout', '-f', defaultBranch], dir);
        await run('git', ['clean', '-fd'], dir);
        await run('git', ['fetch', '--all', '--prune'], dir, 300_000);
        await run('git', ['pull', '--ff-only'], dir).catch(() => {});
        await syncReviewSkills(dir);
        log(`Repo ${fullName} updated (on ${defaultBranch})`);
      } catch (err: any) {
        log(`Failed to update ${fullName}: ${err.message}`);
      }
      continue;
    }

    // Clone the repo with plain URL
    const ownerDir = path.join(REPOS_DIR, owner);
    if (!fs.existsSync(ownerDir)) {
      fs.mkdirSync(ownerDir, { recursive: true });
    }

    const cloneUrl = `https://github.com/${fullName}.git`;
    log(`Cloning ${fullName}...`);
    try {
      await exec('git', ['clone', '--depth', '1', cloneUrl, dir], { timeout: 600_000 });
      await syncReviewSkills(dir);
      log(`Cloned ${fullName}`);
    } catch (err: any) {
      log(`Failed to clone ${fullName}: ${err.message}`);
    }
  }
}

/**
 * Prepare the local repo for reviewing a specific PR.
 * Fetches the PR ref and checks it out.
 * Returns the local repo directory path.
 */
export async function prepareForReview(fullName: string, prNumber: number): Promise<string> {
  const [owner, repo] = fullName.split('/');
  const dir = repoDir(owner, repo);

  if (!fs.existsSync(path.join(dir, '.git'))) {
    throw new Error(`Repo ${fullName} not cloned. Run initRepos first.`);
  }

  const branchName = `pr-${prNumber}`;
  const defaultBranch = await getDefaultBranch(dir);

  // Clean working tree and switch to default branch to avoid checkout conflicts
  log(`Fetching ${fullName} PR #${prNumber}...`);
  await run('git', ['checkout', '-f', defaultBranch], dir);
  await run('git', ['clean', '-fd'], dir);

  // Fetch the PR ref (shallow fetch for speed)
  await run('git', ['fetch', '--depth', '1', 'origin', `pull/${prNumber}/head:${branchName}`, '--force'], dir, 300_000);

  // Checkout the PR branch
  await run('git', ['checkout', '-f', branchName], dir);
  await syncReviewSkills(dir);
  log(`Checked out PR #${prNumber} in ${fullName}`);

  return dir;
}

/**
 * Get the repo directory path for a given repo.
 */
export function getRepoDir(fullName: string): string {
  const [owner, repo] = fullName.split('/');
  return repoDir(owner, repo);
}
