import test from "node:test";
import assert from "node:assert/strict";

import { rankEngineers, scorePullRequest } from "./src/impactModel.js";

test("scores PRs with quality evidence higher than vague PRs", () => {
  const strongPullRequest = makePullRequest({
    title: "fix(flags): simplify variant sync validation",
    body: `
## Problem
Variant sync failed on invalid input.

## Changes
Extracted a shared helper, removed duplication, and added validation.

## How did you test this code?
Added pytest regression tests and confirmed the edge case.
    `,
  });
  const vaguePullRequest = makePullRequest({
    title: "update stuff",
    body: "small change",
  });

  assert.ok(scorePullRequest(strongPullRequest).score > scorePullRequest(vaguePullRequest).score);
});

test("ranks engineers by average quality evidence without using raw PR count as the main signal", () => {
  const rankedEngineers = rankEngineers([
    makePullRequest({
      login: "focused",
      title: "refactor(api): extract reusable validation service",
      body: `
## Problem
The validation path was duplicated.

## Changes
Extracted shared helpers, removed duplication, and kept behavior unchanged.

## How did you test this code?
Added unit test coverage and regression tests.
      `,
    }),
    makePullRequest({ login: "noisy", title: "change one", body: "misc" }),
    makePullRequest({ login: "noisy", title: "change two", body: "misc" }),
    makePullRequest({ login: "noisy", title: "change three", body: "misc" }),
  ]);

  assert.equal(rankedEngineers[0].login, "focused");
});

function makePullRequest({ login = "engineer", title, body }) {
  return {
    number: 1,
    title,
    body,
    html_url: "https://github.com/yulkalongneck/posthog/pull/1",
    labels: [],
    user: {
      login,
      avatar_url: "https://example.com/avatar.png",
      html_url: `https://github.com/${login}`,
    },
    pull_request: {
      merged_at: "2026-05-01T00:00:00Z",
    },
  };
}
