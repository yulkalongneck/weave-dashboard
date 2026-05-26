import test from "node:test";
import assert from "node:assert/strict";

import { fetchMergedPullRequests } from "./src/githubApi.js";

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
