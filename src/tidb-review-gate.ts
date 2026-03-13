import type { GitHubClient, PRStatusCheck } from './github.js';

export const TIDB_REPO = 'pingcap/tidb';
const TIDB_BUILD_CHECK = 'idc-jenkins-ci-tidb/build';
const TIDB_CHECK_DEV_CHECK = 'idc-jenkins-ci-tidb/check_dev';
const TIDB_UNIT_TEST_CHECKS = [
  'idc-jenkins-ci-tidb/unit-test',
  'pull-unit-test-next-gen',
];

export type TidbReviewGateResult =
  | { state: 'ready'; reason: string }
  | { state: 'waiting-ci'; reason: string }
  | { state: 'ci-failed'; reason: string }
  | { state: 'ci-fetch-error'; reason: string };

export function isTidbRepo(fullName: string): boolean {
  return fullName.toLowerCase() === TIDB_REPO;
}

function isSuccessState(state: string | undefined): boolean {
  return (state || '').toUpperCase() === 'SUCCESS';
}

const FAILED_STATES = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED']);

function isFailedState(state: string | undefined): boolean {
  return FAILED_STATES.has((state || '').toUpperCase());
}

function getCheckState(checks: PRStatusCheck[], name: string): string {
  const check = checks.find((item) => item.name === name);
  return (check?.state || 'MISSING').toUpperCase();
}

export async function getTidbReviewGate(
  github: GitHubClient,
  owner: string,
  repo: string,
  number: number,
): Promise<TidbReviewGateResult> {
  const statusResult = await github.getPRStatusChecks(owner, repo, number);
  if (!statusResult.ok) {
    return {
      state: 'ci-fetch-error',
      reason: statusResult.error || 'failed to fetch CI status data',
    };
  }

  const checks = statusResult.checks;
  if (checks.length === 0) {
    return { state: 'waiting-ci', reason: 'waiting for CI status data' };
  }

  const buildState = getCheckState(checks, TIDB_BUILD_CHECK);
  const checkDevState = getCheckState(checks, TIDB_CHECK_DEV_CHECK);
  const unitCheckStates = TIDB_UNIT_TEST_CHECKS.map((name) => getCheckState(checks, name));
  const unitStates = TIDB_UNIT_TEST_CHECKS.map((name) => `${name}=${getCheckState(checks, name)}`);
  const unitSucceeded = TIDB_UNIT_TEST_CHECKS.some((name) => isSuccessState(getCheckState(checks, name)));

  // Detect explicit failures (not just "not yet succeeded")
  if (isFailedState(buildState)) {
    return { state: 'ci-failed', reason: `${TIDB_BUILD_CHECK}=${buildState}` };
  }
  if (isFailedState(checkDevState)) {
    return { state: 'ci-failed', reason: `${TIDB_CHECK_DEV_CHECK}=${checkDevState}` };
  }
  const allUnitsFailed = unitCheckStates.length > 0
    && unitCheckStates.every((s) => isFailedState(s));
  if (allUnitsFailed) {
    return { state: 'ci-failed', reason: `all unit tests failed (${unitStates.join(', ')})` };
  }

  if (!isSuccessState(buildState)) {
    return { state: 'waiting-ci', reason: `${TIDB_BUILD_CHECK}=${buildState}` };
  }
  if (!isSuccessState(checkDevState)) {
    return { state: 'waiting-ci', reason: `${TIDB_CHECK_DEV_CHECK}=${checkDevState}` };
  }
  if (!unitSucceeded) {
    return { state: 'waiting-ci', reason: `unit-test gate unmet (${unitStates.join(', ')})` };
  }

  return {
    state: 'ready',
    reason: `gate passed (${TIDB_BUILD_CHECK}=${buildState}, ${TIDB_CHECK_DEV_CHECK}=${checkDevState}, ${unitStates.join(', ')})`,
  };
}
