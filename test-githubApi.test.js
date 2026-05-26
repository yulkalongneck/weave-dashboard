import test from "node:test";
import assert from "node:assert/strict";

import { fetchMergedPullRequests, fetchRepositoryContributionsEssential } from "./src/githubApi.js";

test("fetches all pages across split date windows instead of sampling the first page", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    const request = parseRequest(url);
    requests.push(request);

    const payload = buildPayload(request);

    return {
      ok: true,
      status: 200,
      headers: new Map(),
      async json() {
        return payload;
      },
    };
  };

  const result = await fetchMergedPullRequests({
    lookbackDays: 90,
    includeContributors: true,
    fetchImpl,
    endDate: new Date("2026-04-10T00:00:00Z"),
  });

  assert.equal(result.mergedAfter, "2026-01-10");
  assert.equal(result.mergedBefore, "2026-04-10");
  assert.equal(result.totalMatchingPullRequests, 102);
  assert.equal(result.pullRequests.length, 102);
  assert.deepEqual(
    result.dateWindows.map((window) => `${window.startDate}..${window.endDate}`),
    ["2026-01-10..2026-02-24", "2026-02-25..2026-04-10"],
  );
  assert.deepEqual(
    requests.map((request) => `${request.range}:${request.page}`),
    ["2026-01-10..2026-04-10:1", "2026-01-10..2026-02-24:1", "2026-01-10..2026-02-24:2", "2026-02-25..2026-04-10:1"],
  );
});

test("uses GraphQL essential fields for token-backed contribution fetching", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body });

    return {
      ok: true,
      status: 200,
      headers: new Map(),
      async json() {
        if (body.query.includes("PullRequestSearch")) {
          return {
            data: {
              rateLimit: { limit: 5000, remaining: 4999, resetAt: "2026-04-10T01:00:00Z", cost: 1 },
              search: {
                issueCount: 0,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          };
        }

        return {
          data: {
            rateLimit: { limit: 5000, remaining: 4998, resetAt: "2026-04-10T01:00:00Z", cost: 1 },
            repository: {
              defaultBranchRef: {
                target: {
                  history: {
                    totalCount: 2,
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        oid: "abcdef123456",
                        abbreviatedOid: "abcdef1",
                        url: "https://github.com/yulkalongneck/posthog/commit/abcdef123456",
                        committedDate: "2026-04-01T00:00:00Z",
                        messageHeadline: "fix(flags): clarify rollout validation",
                        messageBody: "## Problem\nBad validation.\n\n## Changes\nAdded explicit validation.\n\n## How did you test this code?\nAdded unit tests.",
                        author: {
                          name: "Engineer",
                          email: "engineer@example.com",
                          user: {
                            login: "engineer",
                            avatarUrl: "https://example.com/avatar.png",
                            url: "https://github.com/engineer",
                          },
                        },
                      },
                      {
                        oid: "botdef123456",
                        abbreviatedOid: "botdef1",
                        url: "https://github.com/yulkalongneck/posthog/commit/botdef123456",
                        committedDate: "2026-04-01T00:00:00Z",
                        messageHeadline: "chore: generated update",
                        messageBody: "",
                        author: {
                          name: "dependabot[bot]",
                          email: "bot@example.com",
                          user: {
                            login: "dependabot[bot]",
                            avatarUrl: "https://example.com/bot.png",
                            url: "https://github.com/apps/dependabot",
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        };
      },
    };
  };

  const result = await fetchRepositoryContributionsEssential({
    lookbackDays: 90,
    token: "valid-token",
    fetchImpl,
    endDate: new Date("2026-04-10T00:00:00Z"),
  });

  assert.equal(result.dataSource, "graphql");
  assert.equal(result.sourceType, "commits");
  assert.equal(result.requestCount, 2);
  assert.equal(result.totalMatchingPullRequests, 0);
  assert.equal(result.totalMatchingContributions, 2);
  assert.equal(result.contributions.length, 1);
  assert.equal(result.contributions[0].title, "fix(flags): clarify rollout validation");
  assert.ok(requests.every((request) => request.url === "https://api.github.com/graphql"));
});

function parseRequest(url) {
  const parsedUrl = new URL(url);
  const query = parsedUrl.searchParams.get("q");
  const [, startDate, endDate] = query.match(/merged:(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/);

  return {
    page: Number(parsedUrl.searchParams.get("page")),
    range: `${startDate}..${endDate}`,
  };
}

function buildPayload({ page, range }) {
  if (range === "2026-01-10..2026-04-10") {
    return { total_count: 1201, items: [] };
  }

  if (range === "2026-01-10..2026-02-24") {
    return {
      total_count: 101,
      items: Array.from({ length: page === 1 ? 100 : 1 }, (_, index) =>
        makePullRequest(page === 1 ? index + 1 : 101),
      ),
    };
  }

  return {
    total_count: 1,
    items: [makePullRequest(102)],
  };
}

function makePullRequest(number) {
  return {
    number,
    title: `fix(test): pull request ${number}`,
    body: "## Problem\nA bug.\n\n## Changes\nA fix.\n\n## How did you test this code?\nAdded tests.",
    html_url: `https://github.com/yulkalongneck/posthog/pull/${number}`,
    labels: [],
    author_association: "MEMBER",
    user: {
      login: `engineer-${number}`,
      type: "User",
      avatar_url: "https://example.com/avatar.png",
      html_url: `https://github.com/engineer-${number}`,
    },
    pull_request: {
      merged_at: "2026-03-01T00:00:00Z",
    },
  };
}
