import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { fetchRepositoryContributions } from "../src/githubApi.js";
import { rankEngineers, scorePullRequest } from "../src/impactModel.js";

const DEFAULT_LOOKBACK_DAYS = 90;
const REPOSITORY = "yulkalongneck/posthog";

const lookbackDays = readLookbackDays();
const token = process.env.GITHUB_TOKEN ?? "";
const includeContributors = !process.argv.includes("--members-only");

console.error(`Collecting ${REPOSITORY} merged PR data for the last ${lookbackDays} days...`);

const result = await fetchRepositoryContributions({
  lookbackDays,
  token,
  includeContributors,
  onProgress: logProgress,
});

const scoredContributions = result.contributions.map(toScoredContribution);
const rankedEngineers = rankEngineers(result.contributions);
const generatedAt = new Date().toISOString();

const dataset = {
  repository: REPOSITORY,
  generatedAt,
  mergedAfter: result.mergedAfter,
  mergedBefore: result.mergedBefore,
  lookbackDays: result.lookbackDays,
  sourceType: result.sourceType,
  counts: {
    eligibleContributions: result.contributions.length,
    matchingContributionsBeforeFilters: result.totalMatchingContributions,
    matchingPullRequestsBeforeFilters: result.totalMatchingPullRequests,
    rawPullRequestsFetched: result.rawPullRequestCount,
    dateWindows: result.dateWindows?.length ?? 0,
    commitPages: result.commitPages ?? 0,
    githubRequests: result.requestCount,
  },
  filters: {
    includeContributors,
    excludedBots: true,
  },
  dateWindows: result.dateWindows,
  ranking: compactRanking(rankedEngineers),
  contributions: scoredContributions,
};

await mkdir("data", { recursive: true });

const suffix = `${result.lookbackDays}d`;
const datasetPath = path.join("data", `posthog-engineer-impact-${suffix}.json`);

await writeFile(datasetPath, `${JSON.stringify(dataset, null, 2)}\n`);

console.error(`Wrote ${datasetPath}`);

function toScoredContribution(contribution) {
  const score = scorePullRequest(contribution);

  return {
    type: contribution.contributionType ?? "pullRequest",
    number: contribution.number,
    sha: contribution.sha,
    displayId: contribution.displayId ?? `#${contribution.number}`,
    title: contribution.title,
    url: contribution.html_url,
    author: contribution.user.login,
    authorAssociation: contribution.author_association,
    createdAt: contribution.created_at,
    mergedAt: contribution.pull_request?.merged_at,
    updatedAt: contribution.updated_at,
    comments: contribution.comments,
    reactions: contribution.reactions?.total_count ?? 0,
    labels: (contribution.labels ?? []).map((label) => label.name),
    body: contribution.body ?? "",
    score,
  };
}

function compactRanking(ranking) {
  return ranking.map((engineer) => ({
    login: engineer.login,
    avatarUrl: engineer.avatarUrl,
    profileUrl: engineer.profileUrl,
    impactScore: engineer.impactScore,
    contributionCount: engineer.pullRequestCount,
    criteria: engineer.criteria,
    topReasons: engineer.topReasons,
    topContributions: engineer.topPullRequests.map((contribution) => ({
      displayId: contribution.displayId ?? `#${contribution.number}`,
      title: contribution.title,
      url: contribution.url,
      mergedAt: contribution.mergedAt,
      score: contribution.score,
      criteria: contribution.criteria,
      reasons: contribution.reasons,
    })),
  }));
}

function logProgress(progress) {
  if (progress.status === "rate-limited") {
    console.error(
      `Rate limited after ${progress.requestCount} requests; waiting ${Math.ceil(progress.waitMs / 1000)}s...`,
    );
    return;
  }

  if (progress.status === "scanned") {
    console.error(
      `Scanned ${progress.startDate}..${progress.endDate}: ${progress.totalCount} matches (${progress.requestCount} requests)`,
    );
    return;
  }

  if (progress.status === "commits-fetching") {
    console.error(`Fetched ${progress.fetchedCount} commits across ${progress.page} pages (${progress.requestCount} requests)`);
    return;
  }

  console.error(
    `Fetched ${progress.fetchedCount}/${progress.totalCount} for ${progress.startDate}..${progress.endDate} (${progress.requestCount} requests)`,
  );
}

function readLookbackDays() {
  const cliValue = process.argv.find((argument) => argument.startsWith("--days="))?.split("=")[1];
  const days = Number(cliValue ?? DEFAULT_LOOKBACK_DAYS);

  return Number.isFinite(days) ? Math.max(days, DEFAULT_LOOKBACK_DAYS) : DEFAULT_LOOKBACK_DAYS;
}
