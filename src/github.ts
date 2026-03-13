import { Octokit } from '@octokit/rest';

export interface GitHubPR {
  number: number;
  title: string;
  author: string;
  head_sha: string;
  base_branch: string;
  state: string;
  labels: string[];
  created_at: string;
  updated_at: string;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  comments: {
    id: number | null;
    author: string;
    body: string;
    createdAt: string;
  }[];
}

export interface FollowupTarget {
  threadId: string;
  parentCommentId: number;
  replyCommentId: number;
  replyAuthor: string;
  replyCreatedAt: string;
}

export interface PRStatusCheck {
  name: string;
  state: string;
  detailsUrl: string | null;
}

export interface PRStatusChecksResult {
  checks: PRStatusCheck[];
  ok: boolean;
  error?: string;
}

export interface GitHubPRFile {
  filename: string;
  previous_filename?: string;
}

function mapPullRequest(pr: any): GitHubPR {
  return {
    number: pr.number,
    title: pr.title,
    author: pr.user?.login || 'unknown',
    head_sha: pr.head.sha,
    base_branch: pr.base.ref,
    state: pr.state,
    labels: (pr.labels || []).map((label: any) => label.name || '').filter((name: string): name is string => Boolean(name)),
    created_at: pr.created_at,
    updated_at: pr.updated_at,
  };
}

function dedupeStatusChecks(checks: PRStatusCheck[]): PRStatusCheck[] {
  const seen = new Set<string>();
  const result: PRStatusCheck[] = [];

  for (const check of checks) {
    if (seen.has(check.name)) {
      continue;
    }
    seen.add(check.name);
    result.push(check);
  }

  return result;
}

export class GitHubClient {
  private octokit: Octokit;
  private _botUser: string | null = null;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  async getBotUser(): Promise<string> {
    if (this._botUser) return this._botUser;
    const { data } = await this.octokit.users.getAuthenticated();
    this._botUser = data.login;
    return this._botUser;
  }

  async listOpenPRs(owner: string, repo: string): Promise<GitHubPR[]> {
    const { data } = await this.octokit.pulls.list({
      owner,
      repo,
      state: 'open',
      per_page: 100,
      sort: 'updated',
      direction: 'desc',
    });
    return data.map((pr) => mapPullRequest(pr));
  }

  async getPullRequest(owner: string, repo: string, number: number): Promise<GitHubPR> {
    const { data } = await this.octokit.pulls.get({ owner, repo, pull_number: number });
    return mapPullRequest(data);
  }

  async getPRState(owner: string, repo: string, number: number): Promise<{ state: string; merged: boolean }> {
    const { data } = await this.octokit.pulls.get({ owner, repo, pull_number: number });
    return { state: data.state, merged: data.merged };
  }

  async listPullRequestFiles(owner: string, repo: string, number: number): Promise<GitHubPRFile[]> {
    const files: GitHubPRFile[] = [];

    for (let page = 1; ; page++) {
      const { data } = await this.octokit.pulls.listFiles({
        owner,
        repo,
        pull_number: number,
        per_page: 100,
        page,
      });

      files.push(...data.map((file) => ({
        filename: file.filename,
        previous_filename: file.previous_filename,
      })));

      if (data.length < 100) {
        break;
      }
    }

    return files;
  }

  async hasGoChanges(owner: string, repo: string, number: number): Promise<boolean> {
    const files = await this.listPullRequestFiles(owner, repo, number);
    return files.some((file) => {
      const names = [file.filename, file.previous_filename].filter((value): value is string => Boolean(value));
      return names.some((name) => name.endsWith('.go'));
    });
  }

  async getPRStatusChecks(owner: string, repo: string, number: number): Promise<PRStatusChecksResult> {
    try {
      const { data: pull } = await this.octokit.pulls.get({ owner, repo, pull_number: number });
      const ref = pull.head.sha;

      const { data: combinedStatus } = await this.octokit.repos.getCombinedStatusForRef({
        owner,
        repo,
        ref,
        per_page: 100,
      });

      const statusContextChecks: PRStatusCheck[] = combinedStatus.statuses.map((status) => ({
        name: status.context,
        state: (status.state || 'PENDING').toUpperCase(),
        detailsUrl: status.target_url,
      }));

      let checkRunChecks: PRStatusCheck[] = [];
      try {
        const { data: checkRuns } = await this.octokit.checks.listForRef({
          owner,
          repo,
          ref,
          per_page: 100,
          filter: 'latest',
        });

        checkRunChecks = checkRuns.check_runs.map((checkRun) => ({
          name: checkRun.name,
          state: checkRun.status === 'completed'
            ? (checkRun.conclusion || 'FAILURE').toUpperCase()
            : 'PENDING',
          detailsUrl: checkRun.details_url,
        }));
      } catch (err) {
        console.warn('[github] checks.listForRef failed, continuing with combined status only:', err);
      }

      return {
        checks: dedupeStatusChecks([...statusContextChecks, ...checkRunChecks]),
        ok: true,
      };
    } catch (err) {
      console.error('[github] failed to fetch PR status checks:', err);
      return {
        checks: [],
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getReviewThreads(
    owner: string,
    repo: string,
    number: number,
  ): Promise<{ threads: ReviewThread[]; totalComments: number; unresolvedCount: number }> {
    const botUser = await this.getBotUser();

    try {
      const response: any = await this.octokit.graphql(
        `
        query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewThreads(first: 100) {
                nodes {
                  id
                  isResolved
                  firstComment: comments(first: 1) {
                    nodes {
                      databaseId
                      author { login }
                      body
                      createdAt
                    }
                  }
                  latestComments: comments(last: 100) {
                    nodes {
                      databaseId
                      author { login }
                      body
                      createdAt
                    }
                  }
                }
              }
            }
          }
        }
      `,
        { owner, repo, number },
      );

      const threadNodes = response.repository.pullRequest.reviewThreads.nodes;
      const threads: ReviewThread[] = threadNodes.map((t: any) => ({
        // Keep the thread starter as the first element for bot-thread filtering,
        // then append the latest comments so follow-up detection sees recent replies.
        id: t.id,
        isResolved: t.isResolved,
        comments: [
          ...(t.firstComment?.nodes || []),
          ...((t.latestComments?.nodes || []).filter((c: any) => {
            const first = t.firstComment?.nodes?.[0];
            return !(first && c.createdAt === first.createdAt && (c.author?.login || 'unknown') === (first.author?.login || 'unknown') && c.body === first.body);
          })),
        ].map((c: any) => ({
          id: c.databaseId ?? null,
          author: c.author?.login || 'unknown',
          body: c.body,
          createdAt: c.createdAt,
        })),
      }));

      // Filter to threads started by our bot
      const botThreads = threads.filter((t) => t.comments.length > 0 && t.comments[0].author === botUser);

      return {
        threads: botThreads,
        totalComments: botThreads.length,
        unresolvedCount: botThreads.filter((t) => !t.isResolved).length,
      };
    } catch (err) {
      console.error('[github] GraphQL query failed:', err);
      return { threads: [], totalComments: 0, unresolvedCount: 0 };
    }
  }

  async getFollowupTargets(
    owner: string,
    repo: string,
    number: number,
    since: string,
  ): Promise<{ botUser: string; targets: FollowupTarget[] }> {
    const botUser = await this.getBotUser();
    const { threads } = await this.getReviewThreads(owner, repo, number);
    const targets: FollowupTarget[] = [];

    for (const thread of threads) {
      if (thread.isResolved) continue;

      const parentCommentId = thread.comments[0]?.id;
      if (!parentCommentId) continue;

      for (const comment of thread.comments.slice(1)) {
        if (comment.author === botUser || comment.createdAt <= since || !comment.id) {
          continue;
        }

        targets.push({
          threadId: thread.id,
          parentCommentId,
          replyCommentId: comment.id,
          replyAuthor: comment.author,
          replyCreatedAt: comment.createdAt,
        });
      }
    }

    return { botUser, targets };
  }

  async hasNewReplies(owner: string, repo: string, number: number, since: string): Promise<boolean> {
    const { targets } = await this.getFollowupTargets(owner, repo, number, since);
    return targets.length > 0;
  }
}
