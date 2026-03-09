import { Octokit } from '@octokit/rest';

export interface GitHubPR {
  number: number;
  title: string;
  author: string;
  head_sha: string;
  state: string;
  created_at: string;
  updated_at: string;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  comments: {
    author: string;
    body: string;
    createdAt: string;
  }[];
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
    return data.map((pr) => ({
      number: pr.number,
      title: pr.title,
      author: pr.user?.login || 'unknown',
      head_sha: pr.head.sha,
      state: pr.state,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
    }));
  }

  async getPRState(owner: string, repo: string, number: number): Promise<{ state: string; merged: boolean }> {
    const { data } = await this.octokit.pulls.get({ owner, repo, pull_number: number });
    return { state: data.state, merged: data.merged };
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
                  comments(first: 20) {
                    nodes {
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
        id: t.id,
        isResolved: t.isResolved,
        comments: t.comments.nodes.map((c: any) => ({
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

  async hasNewReplies(owner: string, repo: string, number: number, since: string): Promise<boolean> {
    const botUser = await this.getBotUser();
    const { threads } = await this.getReviewThreads(owner, repo, number);

    for (const thread of threads) {
      if (thread.isResolved) continue;
      // Check if there are replies from non-bot users after 'since'
      for (const comment of thread.comments.slice(1)) {
        if (comment.author !== botUser && comment.createdAt > since) {
          return true;
        }
      }
    }
    return false;
  }
}
