const GITHUB_API_ROOT = "https://api.github.com";
const REPOSITORY = "yulkalongneck/posthog";
const MAX_RESULTS_PER_PAGE = 100;
const MIN_LOOKBACK_DAYS = 90;
const GITHUB_SEARCH_RESULT_CAP = 1000;
const MAX_RATE_LIMIT_WAIT_MS = 70_000;

export async function fetchMergedPullRequests({
  lookbackDays = MIN_LOOKBACK_DAYS,
  token,
  includeContributors = true,
  fetchImpl = fetch,
  onProgress = () => {},
  endDate = new Date(),
}) {
  const requestedLookbackDays = Number(lookbackDays);
  const normalizedLookbackDays = Number.isFinite(requestedLookbackDays)
    ? Math.max(requestedLookbackDays, MIN_LOOKBACK_DAYS)
    : MIN_LOOKBACK_DAYS;
  const mergedAfter = toDateOnly(daysAgo(normalizedLookbackDays, endDate));
  const mergedBefore = toDateOnly(endDate);
  const collection = createCollectionTracker(onProgress);

  const allPullRequests = await fetchPullRequestsForDateRange({
    startDate: mergedAfter,
    endDate: mergedBefore,
    token,
    fetchImpl,
    collection,
  });

  const pullRequests = uniquePullRequests(allPullRequests)
    .filter((item) => item.pull_request?.merged_at)
    .filter((item) => !isBot(item.user))
    .filter((item) => includeContributors || item.author_association === "MEMBER" || item.author_association === "COLLABORATOR")
    .sort((left, right) => new Date(right.pull_request.merged_at) - new Date(left.pull_request.merged_at));

  return {
    mergedAfter,
    mergedBefore,
    lookbackDays: normalizedLookbackDays,
    totalMatchingPullRequests: collection.totalMatchingPullRequests,
    rawPullRequestCount: collection.rawPullRequestCount,
    requestCount: collection.requestCount,
    dateWindows: collection.dateWindows,
    pullRequests,
  };
}

export async function fetchRepositoryContributions(options) {
  const pullRequestResult = await fetchMergedPullRequests(options);

  if (pullRequestResult.pullRequests.length > 0) {
    return {
      ...pullRequestResult,
      sourceType: "pullRequests",
      contributions: pullRequestResult.pullRequests,
      totalMatchingContributions: pullRequestResult.totalMatchingPullRequests,
    };
  }

  const commitResult = await fetchRecentCommits(options);

  return {
    ...commitResult,
    sourceType: "commits",
    contributions: commitResult.commits,
    pullRequests: commitResult.commits,
    totalMatchingPullRequests: pullRequestResult.totalMatchingPullRequests,
    rawPullRequestCount: pullRequestResult.rawPullRequestCount,
    dateWindows: pullRequestResult.dateWindows,
    requestCount: pullRequestResult.requestCount + commitResult.requestCount,
  };
}

export async function fetchRecentCommits({
  lookbackDays = MIN_LOOKBACK_DAYS,
  token,
  fetchImpl = fetch,
  onProgress = () => {},
  endDate = new Date(),
}) {
  const requestedLookbackDays = Number(lookbackDays);
  const normalizedLookbackDays = Number.isFinite(requestedLookbackDays)
    ? Math.max(requestedLookbackDays, MIN_LOOKBACK_DAYS)
    : MIN_LOOKBACK_DAYS;
  const sinceDate = toDateOnly(daysAgo(normalizedLookbackDays, endDate));
  const untilDate = toDateOnly(endDate);
  const collection = createCollectionTracker(onProgress);
  const commits = [];

  for (let page = 1; ; page += 1) {
    const pageCommits = await fetchCommitPage({
      sinceDate,
      untilDate,
      page,
      token,
      fetchImpl,
      collection,
    });

    commits.push(...pageCommits.map(normalizeCommit));
    collection.onProgress({
      status: "commits-fetching",
      page,
      fetchedCount: commits.length,
      requestCount: collection.requestCount,
    });

    if (pageCommits.length < MAX_RESULTS_PER_PAGE) {
      break;
    }
  }

  return {
    mergedAfter: sinceDate,
    mergedBefore: untilDate,
    lookbackDays: normalizedLookbackDays,
    totalMatchingContributions: commits.length,
    rawCommitCount: commits.length,
    requestCount: collection.requestCount,
    commitPages: Math.ceil(commits.length / MAX_RESULTS_PER_PAGE),
    commits: uniqueCommits(commits)
      .filter((commit) => commit.pull_request?.merged_at)
      .filter((commit) => !isBot(commit.user))
      .sort((left, right) => new Date(right.pull_request.merged_at) - new Date(left.pull_request.merged_at)),
  };
}

async function fetchPullRequestsForDateRange({ startDate, endDate, token, fetchImpl, collection }) {
  const firstPage = await fetchPullRequestPage({ startDate, endDate, page: 1, token, fetchImpl, collection });
  const totalCount = firstPage.total_count ?? 0;

  collection.onProgress({
    status: "scanned",
    startDate,
    endDate,
    totalCount,
    requestCount: collection.requestCount,
  });

  if (totalCount > GITHUB_SEARCH_RESULT_CAP) {
    const split = splitDateRange(startDate, endDate);

    if (!split) {
      throw new Error(
        `GitHub returned more than ${GITHUB_SEARCH_RESULT_CAP} merged PRs for ${startDate}. Use a narrower date window.`,
      );
    }

    const leftItems = await fetchPullRequestsForDateRange({
      startDate: split.left.startDate,
      endDate: split.left.endDate,
      token,
      fetchImpl,
      collection,
    });
    const rightItems = await fetchPullRequestsForDateRange({
      startDate: split.right.startDate,
      endDate: split.right.endDate,
      token,
      fetchImpl,
      collection,
    });

    return [...leftItems, ...rightItems];
  }

  collection.totalMatchingPullRequests += totalCount;
  collection.rawPullRequestCount += firstPage.items.length;
  collection.dateWindows.push({ startDate, endDate, totalCount });

  const totalPages = Math.ceil(totalCount / MAX_RESULTS_PER_PAGE);
  const items = [...firstPage.items];

  for (let page = 2; page <= totalPages; page += 1) {
    const pagePayload = await fetchPullRequestPage({ startDate, endDate, page, token, fetchImpl, collection });
    items.push(...pagePayload.items);
    collection.rawPullRequestCount += pagePayload.items.length;
    collection.onProgress({
      status: "fetching",
      startDate,
      endDate,
      totalCount,
      fetchedCount: items.length,
      requestCount: collection.requestCount,
    });
  }

  return items;
}

async function fetchPullRequestPage({ startDate, endDate, page, token, fetchImpl, collection }) {
  const query = `repo:${REPOSITORY} is:pr is:merged merged:${startDate}..${endDate}`;
  const url = new URL(`${GITHUB_API_ROOT}/search/issues`);
  url.searchParams.set("q", query);
  url.searchParams.set("sort", "created");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", String(MAX_RESULTS_PER_PAGE));
  url.searchParams.set("page", String(page));

  return fetchGitHubJson({
    url,
    token,
    fetchImpl,
    collection,
    rateLimitContext: { startDate, endDate, page },
  });
}

async function fetchCommitPage({ sinceDate, untilDate, page, token, fetchImpl, collection }) {
  const url = new URL(`${GITHUB_API_ROOT}/repos/${REPOSITORY}/commits`);
  url.searchParams.set("since", `${sinceDate}T00:00:00Z`);
  url.searchParams.set("until", `${untilDate}T23:59:59Z`);
  url.searchParams.set("per_page", String(MAX_RESULTS_PER_PAGE));
  url.searchParams.set("page", String(page));

  return fetchGitHubJson({
    url,
    token,
    fetchImpl,
    collection,
    rateLimitContext: { page, sourceType: "commits" },
  });
}

async function fetchGitHubJson({ url, token, fetchImpl, collection, rateLimitContext }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetchImpl(url, {
      headers: buildHeaders(token),
    });

    collection.requestCount += 1;

    if (isRetryableRateLimit(response)) {
      const waitMs = getRateLimitWaitMs(response);

      if (attempt === 0 && waitMs <= MAX_RATE_LIMIT_WAIT_MS) {
        collection.onProgress({
          status: "rate-limited",
          ...rateLimitContext,
          waitMs,
          requestCount: collection.requestCount,
        });
        await delay(waitMs);
        continue;
      }
    }

    if (!response.ok) {
      throw await buildGitHubError(response);
    }

    return response.json();
  }
}

function buildHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

async function buildGitHubError(response) {
  let message = `GitHub API request failed with ${response.status}.`;

  try {
    const payload = await response.json();
    if (payload.message) {
      message = payload.message;
    }
  } catch {
    // Leave the generic message in place when GitHub returns non-JSON content.
  }

  if (response.status === 403) {
    message = `${message} Add a GitHub token if you hit the public API rate limit.`;
  }

  return new Error(message);
}

function isBot(user) {
  return user?.type === "Bot" || user?.login?.endsWith("[bot]");
}

function uniquePullRequests(pullRequests) {
  return Array.from(new Map(pullRequests.map((pullRequest) => [pullRequest.number, pullRequest])).values());
}

function uniqueCommits(commits) {
  return Array.from(new Map(commits.map((commit) => [commit.sha, commit])).values());
}

function normalizeCommit(commit) {
  const [title, ...bodyLines] = (commit.commit?.message ?? "").split("\n");
  const authoredAt = commit.commit?.author?.date;
  const fallbackLogin = commit.commit?.author?.name ?? "unknown";

  return {
    sha: commit.sha,
    number: commit.sha.slice(0, 7),
    displayId: commit.sha.slice(0, 7),
    title,
    body: bodyLines.join("\n").trim(),
    html_url: commit.html_url,
    labels: [],
    comments: commit.commit?.comment_count ?? 0,
    author_association: "COMMIT_AUTHOR",
    user: commit.author ?? {
      login: fallbackLogin,
      type: fallbackLogin.includes("[bot]") ? "Bot" : "User",
      avatar_url: "",
      html_url: commit.html_url,
    },
    pull_request: {
      merged_at: authoredAt,
    },
    contributionType: "commit",
  };
}

function splitDateRange(startDate, endDate) {
  const start = parseDateOnly(startDate);
  const end = parseDateOnly(endDate);
  const dayCount = Math.floor((end - start) / 86_400_000);

  if (dayCount <= 0) {
    return null;
  }

  const midpoint = addDays(start, Math.floor(dayCount / 2));
  const rightStart = addDays(midpoint, 1);

  return {
    left: {
      startDate,
      endDate: toDateOnly(midpoint),
    },
    right: {
      startDate: toDateOnly(rightStart),
      endDate,
    },
  };
}

function createCollectionTracker(onProgress) {
  return {
    requestCount: 0,
    rawPullRequestCount: 0,
    totalMatchingPullRequests: 0,
    dateWindows: [],
    onProgress,
  };
}

function daysAgo(dayCount, endDate) {
  const date = new Date(endDate);
  date.setUTCDate(date.getUTCDate() - Number(dayCount));
  return date;
}

function toDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function parseDateOnly(date) {
  return new Date(`${date}T00:00:00Z`);
}

function addDays(date, dayCount) {
  const nextDate = new Date(date);
  nextDate.setUTCDate(nextDate.getUTCDate() + dayCount);
  return nextDate;
}

function isRetryableRateLimit(response) {
  return response.status === 403 && response.headers?.get("x-ratelimit-remaining") === "0";
}

function getRateLimitWaitMs(response) {
  const resetSeconds = Number(response.headers?.get("x-ratelimit-reset"));

  if (!Number.isFinite(resetSeconds)) {
    return MAX_RATE_LIMIT_WAIT_MS + 1;
  }

  return Math.max(0, resetSeconds * 1000 - Date.now() + 1000);
}

function delay(waitMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, waitMs);
  });
}
