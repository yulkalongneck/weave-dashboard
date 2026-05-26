const GITHUB_API_ROOT = "https://api.github.com";
const GITHUB_GRAPHQL_ROOT = "https://api.github.com/graphql";
const REPOSITORY = "yulkalongneck/posthog";
const [REPOSITORY_OWNER, REPOSITORY_NAME] = REPOSITORY.split("/");
const MAX_RESULTS_PER_PAGE = 100;
const MIN_LOOKBACK_DAYS = 90;
const GITHUB_SEARCH_RESULT_CAP = 1000;
const MAX_RATE_LIMIT_WAIT_MS = 70_000;
const COMMIT_PAGE_CONCURRENCY = 10;

const PULL_REQUEST_SEARCH_QUERY = `
  query PullRequestSearch($query: String!, $after: String) {
    rateLimit {
      limit
      remaining
      resetAt
      cost
    }
    search(type: ISSUE, query: $query, first: 100, after: $after) {
      issueCount
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        ... on PullRequest {
          number
          title
          body
          url
          mergedAt
          authorAssociation
          comments {
            totalCount
          }
          reactions {
            totalCount
          }
          labels(first: 20) {
            nodes {
              name
            }
          }
          author {
            __typename
            login
            avatarUrl
            url
          }
        }
      }
    }
  }
`;

const COMMIT_HISTORY_QUERY = `
  query CommitHistory($owner: String!, $name: String!, $since: GitTimestamp!, $until: GitTimestamp!, $after: String) {
    rateLimit {
      limit
      remaining
      resetAt
      cost
    }
    repository(owner: $owner, name: $name) {
      defaultBranchRef {
        target {
          ... on Commit {
            history(first: 100, after: $after, since: $since, until: $until) {
              totalCount
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                oid
                abbreviatedOid
                url
                committedDate
                messageHeadline
                messageBody
                author {
                  name
                  email
                  user {
                    login
                    avatarUrl
                    url
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

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
  if (options?.token?.trim()) {
    return fetchRepositoryContributionsEssential(options);
  }

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

export async function fetchRepositoryContributionsEssential({
  lookbackDays = MIN_LOOKBACK_DAYS,
  token,
  includeContributors = true,
  fetchImpl = fetch,
  onProgress = () => {},
  endDate = new Date(),
}) {
  if (!token?.trim()) {
    throw new Error("A valid GitHub token is required for essential-field GraphQL fetching.");
  }

  const requestedLookbackDays = Number(lookbackDays);
  const normalizedLookbackDays = Number.isFinite(requestedLookbackDays)
    ? Math.max(requestedLookbackDays, MIN_LOOKBACK_DAYS)
    : MIN_LOOKBACK_DAYS;
  const mergedAfter = toDateOnly(daysAgo(normalizedLookbackDays, endDate));
  const mergedBefore = toDateOnly(endDate);
  const collection = createCollectionTracker(onProgress);
  const pullRequests = await fetchPullRequestsEssentialForDateRange({
    startDate: mergedAfter,
    endDate: mergedBefore,
    token,
    fetchImpl,
    collection,
  });
  const eligiblePullRequests = uniquePullRequests(pullRequests)
    .filter((item) => item.pull_request?.merged_at)
    .filter((item) => !isBot(item.user))
    .filter((item) => includeContributors || item.author_association === "MEMBER" || item.author_association === "COLLABORATOR")
    .sort((left, right) => new Date(right.pull_request.merged_at) - new Date(left.pull_request.merged_at));

  if (eligiblePullRequests.length > 0) {
    return {
      mergedAfter,
      mergedBefore,
      lookbackDays: normalizedLookbackDays,
      sourceType: "pullRequests",
      dataSource: "graphql",
      totalMatchingPullRequests: collection.totalMatchingPullRequests,
      totalMatchingContributions: collection.totalMatchingPullRequests,
      rawPullRequestCount: collection.rawPullRequestCount,
      requestCount: collection.requestCount,
      dateWindows: collection.dateWindows,
      pullRequests: eligiblePullRequests,
      contributions: eligiblePullRequests,
    };
  }

  const commitResult = await fetchRecentCommitsParallel({
    lookbackDays: normalizedLookbackDays,
    token,
    fetchImpl,
    onProgress,
    endDate,
  });

  return {
    ...commitResult,
    sourceType: "commits",
    dataSource: "graphql-pr-search+parallel-rest-commits",
    contributions: commitResult.commits,
    pullRequests: commitResult.commits,
    totalMatchingPullRequests: collection.totalMatchingPullRequests,
    rawPullRequestCount: collection.rawPullRequestCount,
    dateWindows: collection.dateWindows,
    requestCount: collection.requestCount + commitResult.requestCount,
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

export async function fetchRecentCommitsParallel({
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
  const firstPage = await fetchCommitPageWithHeaders({
    sinceDate,
    untilDate,
    page: 1,
    token,
    fetchImpl,
    collection,
  });
  const lastPage = parseLastPageFromLinkHeader(firstPage.headers) ?? 1;
  const commits = [...firstPage.payload.map(normalizeCommit)];
  let fetchedCount = commits.length;

  collection.onProgress({
    status: "parallel-commits-fetching",
    page: 1,
    totalPages: lastPage,
    fetchedCount,
    requestCount: collection.requestCount,
  });

  if (lastPage > 1) {
    const remainingPages = Array.from({ length: lastPage - 1 }, (_, index) => index + 2);
    const remainingCommits = await mapWithConcurrency(remainingPages, COMMIT_PAGE_CONCURRENCY, async (page) => {
      const pageCommits = await fetchCommitPage({
        sinceDate,
        untilDate,
        page,
        token,
        fetchImpl,
        collection,
      });

      fetchedCount += pageCommits.length;
      collection.onProgress({
        status: "parallel-commits-fetching",
        page,
        totalPages: lastPage,
        fetchedCount,
        requestCount: collection.requestCount,
      });

      return pageCommits.map(normalizeCommit);
    });

    commits.push(...remainingCommits.flat());
  }

  return {
    mergedAfter: sinceDate,
    mergedBefore: untilDate,
    lookbackDays: normalizedLookbackDays,
    totalMatchingContributions: commits.length,
    rawCommitCount: commits.length,
    requestCount: collection.requestCount,
    commitPages: lastPage,
    commits: uniqueCommits(commits)
      .filter((commit) => commit.pull_request?.merged_at)
      .filter((commit) => !isBot(commit.user))
      .sort((left, right) => new Date(right.pull_request.merged_at) - new Date(left.pull_request.merged_at)),
  };
}

async function fetchPullRequestsEssentialForDateRange({ startDate, endDate, token, fetchImpl, collection }) {
  const firstPage = await fetchPullRequestEssentialPage({ startDate, endDate, after: null, token, fetchImpl, collection });
  const totalCount = firstPage.search.issueCount ?? 0;

  collection.onProgress({
    status: "graphql-scanned",
    sourceType: "pullRequests",
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

    const leftItems = await fetchPullRequestsEssentialForDateRange({
      startDate: split.left.startDate,
      endDate: split.left.endDate,
      token,
      fetchImpl,
      collection,
    });
    const rightItems = await fetchPullRequestsEssentialForDateRange({
      startDate: split.right.startDate,
      endDate: split.right.endDate,
      token,
      fetchImpl,
      collection,
    });

    return [...leftItems, ...rightItems];
  }

  collection.totalMatchingPullRequests += totalCount;
  collection.rawPullRequestCount += firstPage.search.nodes.length;
  collection.dateWindows.push({ startDate, endDate, totalCount });

  const items = firstPage.search.nodes.map(normalizeGraphQlPullRequest);
  let pageInfo = firstPage.search.pageInfo;

  while (pageInfo.hasNextPage) {
    const pagePayload = await fetchPullRequestEssentialPage({
      startDate,
      endDate,
      after: pageInfo.endCursor,
      token,
      fetchImpl,
      collection,
    });

    items.push(...pagePayload.search.nodes.map(normalizeGraphQlPullRequest));
    collection.rawPullRequestCount += pagePayload.search.nodes.length;
    pageInfo = pagePayload.search.pageInfo;
    collection.onProgress({
      status: "graphql-fetching",
      sourceType: "pullRequests",
      startDate,
      endDate,
      totalCount,
      fetchedCount: items.length,
      requestCount: collection.requestCount,
    });
  }

  return items;
}

async function fetchPullRequestEssentialPage({ startDate, endDate, after, token, fetchImpl, collection }) {
  const query = `repo:${REPOSITORY} is:pr is:merged merged:${startDate}..${endDate}`;
  const payload = await fetchGitHubGraphQL({
    query: PULL_REQUEST_SEARCH_QUERY,
    variables: { query, after },
    token,
    fetchImpl,
    collection,
    rateLimitContext: { sourceType: "pullRequests", startDate, endDate },
  });

  return payload.data;
}

export async function fetchRecentCommitsEssential({
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
  let after = null;
  let totalCount = 0;
  let page = 0;
  let hasNextPage = true;

  while (hasNextPage) {
    page += 1;
    const payload = await fetchCommitEssentialPage({
      sinceDate,
      untilDate,
      after,
      token,
      fetchImpl,
      collection,
    });
    const history = payload.repository.defaultBranchRef.target.history;
    totalCount = history.totalCount;
    commits.push(...history.nodes.map(normalizeGraphQlCommit));
    hasNextPage = history.pageInfo.hasNextPage;
    after = history.pageInfo.endCursor;
    collection.onProgress({
      status: "graphql-commits-fetching",
      page,
      totalCount,
      fetchedCount: commits.length,
      requestCount: collection.requestCount,
    });
  }

  return {
    mergedAfter: sinceDate,
    mergedBefore: untilDate,
    lookbackDays: normalizedLookbackDays,
    totalMatchingContributions: totalCount,
    rawCommitCount: commits.length,
    requestCount: collection.requestCount,
    commitPages: page,
    commits: uniqueCommits(commits)
      .filter((commit) => commit.pull_request?.merged_at)
      .filter((commit) => !isBot(commit.user))
      .sort((left, right) => new Date(right.pull_request.merged_at) - new Date(left.pull_request.merged_at)),
  };
}

async function fetchCommitEssentialPage({ sinceDate, untilDate, after, token, fetchImpl, collection }) {
  const payload = await fetchGitHubGraphQL({
    query: COMMIT_HISTORY_QUERY,
    variables: {
      owner: REPOSITORY_OWNER,
      name: REPOSITORY_NAME,
      since: `${sinceDate}T00:00:00Z`,
      until: `${untilDate}T23:59:59Z`,
      after,
    },
    token,
    fetchImpl,
    collection,
    rateLimitContext: { sourceType: "commits" },
  });

  return payload.data;
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

async function fetchCommitPageWithHeaders({ sinceDate, untilDate, page, token, fetchImpl, collection }) {
  const url = new URL(`${GITHUB_API_ROOT}/repos/${REPOSITORY}/commits`);
  url.searchParams.set("since", `${sinceDate}T00:00:00Z`);
  url.searchParams.set("until", `${untilDate}T23:59:59Z`);
  url.searchParams.set("per_page", String(MAX_RESULTS_PER_PAGE));
  url.searchParams.set("page", String(page));

  return fetchGitHubJsonWithHeaders({
    url,
    token,
    fetchImpl,
    collection,
    rateLimitContext: { page, sourceType: "commits" },
  });
}

async function fetchGitHubJson({ url, token, fetchImpl, collection, rateLimitContext }) {
  const response = await fetchGitHubJsonWithHeaders({ url, token, fetchImpl, collection, rateLimitContext });
  return response.payload;
}

async function fetchGitHubJsonWithHeaders({ url, token, fetchImpl, collection, rateLimitContext }) {
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

    return {
      payload: await response.json(),
      headers: response.headers,
    };
  }
}

async function fetchGitHubGraphQL({ query, variables, token, fetchImpl, collection, rateLimitContext }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetchImpl(GITHUB_GRAPHQL_ROOT, {
      method: "POST",
      headers: buildGraphQlHeaders(token),
      body: JSON.stringify({ query, variables }),
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

    const payload = await response.json();

    if (payload.errors?.length) {
      throw buildGraphQlError(payload.errors);
    }

    return payload;
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

function buildGraphQlHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
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

function buildGraphQlError(errors) {
  const message = errors.map((error) => error.message).join("; ");
  const isCredentialError = errors.some((error) => /credential|authorization|token/i.test(error.message));

  return new Error(
    isCredentialError
      ? `${message} Check that the GitHub token is valid and has access to this repository.`
      : `GitHub GraphQL request failed: ${message}`,
  );
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

function normalizeGraphQlPullRequest(pullRequest) {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    body: pullRequest.body ?? "",
    html_url: pullRequest.url,
    labels: pullRequest.labels.nodes.map((label) => ({ name: label.name })),
    comments: pullRequest.comments.totalCount,
    reactions: {
      total_count: pullRequest.reactions.totalCount,
    },
    author_association: pullRequest.authorAssociation,
    user: normalizeGraphQlActor(pullRequest.author, pullRequest.url),
    pull_request: {
      merged_at: pullRequest.mergedAt,
    },
    contributionType: "pullRequest",
  };
}

function normalizeGraphQlCommit(commit) {
  const fallbackLogin = commit.author?.name ?? "unknown";
  const user = commit.author?.user
    ? {
        login: commit.author.user.login,
        type: commit.author.user.login.endsWith("[bot]") ? "Bot" : "User",
        avatar_url: commit.author.user.avatarUrl,
        html_url: commit.author.user.url,
      }
    : {
        login: fallbackLogin,
        type: fallbackLogin.includes("[bot]") ? "Bot" : "User",
        avatar_url: "",
        html_url: commit.url,
      };

  return {
    sha: commit.oid,
    number: commit.abbreviatedOid,
    displayId: commit.abbreviatedOid,
    title: commit.messageHeadline,
    body: commit.messageBody ?? "",
    html_url: commit.url,
    labels: [],
    comments: 0,
    author_association: "COMMIT_AUTHOR",
    user,
    pull_request: {
      merged_at: commit.committedDate,
    },
    contributionType: "commit",
  };
}

function normalizeGraphQlActor(actor, fallbackUrl) {
  if (!actor) {
    return {
      login: "unknown",
      type: "User",
      avatar_url: "",
      html_url: fallbackUrl,
    };
  }

  return {
    login: actor.login,
    type: actor.__typename === "Bot" || actor.login.endsWith("[bot]") ? "Bot" : "User",
    avatar_url: actor.avatarUrl,
    html_url: actor.url,
  };
}

function parseLastPageFromLinkHeader(headers) {
  const linkHeader = readHeader(headers, "link");

  if (!linkHeader) {
    return null;
  }

  const lastLink = linkHeader.split(",").find((part) => part.includes('rel="last"'));
  const match = lastLink?.match(/[?&]page=(\d+)>;\s*rel="last"/);

  return match ? Number(match[1]) : null;
}

function readHeader(headers, name) {
  if (!headers) {
    return null;
  }

  if (typeof headers.get === "function") {
    return headers.get(name) ?? headers.get(name.toLowerCase());
  }

  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
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
