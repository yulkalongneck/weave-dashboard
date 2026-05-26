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

test("uses GraphQL PR probe and parallel REST pages for token-backed commit fallback", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    if (String(url) === "https://api.github.com/graphql") {
      const body = JSON.parse(options.body);
      requests.push({ type: "graphql", body });

      return {
        ok: true,
        status: 200,
        headers: new Map(),
        async json() {
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
        },
      };
    }

    const parsedUrl = new URL(url);
    const page = Number(parsedUrl.searchParams.get("page"));
    requests.push({ type: "rest", page });

    return {
      ok: true,
      status: 200,
      headers: new Map(page === 1 ? [["link", '<https://api.github.com/repos/yulkalongneck/posthog/commits?per_page=100&page=3>; rel="last"']] : []),
      async json() {
        if (page === 1) {
          return Array.from({ length: 100 }, (_, index) => makeCommit(index + 1));
        }

        if (page === 2) {
          return Array.from({ length: 100 }, (_, index) => makeCommit(index + 101));
        }

        return [makeCommit(201), makeCommit(202, "dependabot[bot]", "Bot")];
      },
    };
  };

  const result = await fetchRepositoryContributionsEssential({
    lookbackDays: 90,
    token: "valid-token",
    fetchImpl,
    endDate: new Date("2026-04-10T00:00:00Z"),
  });

  assert.equal(result.dataSource, "graphql-pr-search+parallel-rest-commits");
  assert.equal(result.sourceType, "commits");
  assert.equal(result.requestCount, 4);
  assert.equal(result.totalMatchingPullRequests, 0);
  assert.equal(result.totalMatchingContributions, 202);
  assert.equal(result.contributions.length, 201);
  assert.ok(result.contributions.some((contribution) => contribution.title === "fix(flags): clarify rollout validation 201"));
  assert.deepEqual(
    requests.map((request) => (request.type === "graphql" ? request.type : `${request.type}:${request.page}`)),
    ["graphql", "rest:1", "rest:2", "rest:3"],
  );
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

function makeCommit(number, login = `engineer-${number}`, type = "User") {
  return {
    sha: `abcdef${String(number).padStart(6, "0")}`,
    html_url: `https://github.com/yulkalongneck/posthog/commit/abcdef${String(number).padStart(6, "0")}`,
    commit: {
      author: {
        name: login,
        email: `${login}@example.com`,
        date: `2026-04-${String((number % 28) + 1).padStart(2, "0")}T00:00:00Z`,
      },
      message: `fix(flags): clarify rollout validation ${number}\n\n## Problem\nBad validation.\n\n## Changes\nAdded explicit validation.\n\n## How did you test this code?\nAdded unit tests.`,
      comment_count: 0,
    },
    author: {
      login,
      type,
      avatar_url: "https://example.com/avatar.png",
      html_url: `https://github.com/${login}`,
    },
  };
}
