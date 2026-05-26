const DEFAULT_WEIGHTS = {
  readability: 25,
  modularity: 25,
  maintainability: 25,
  testability: 25,
};

const TEST_KEYWORDS = [
  "automated test",
  "unit test",
  "integration test",
  "e2e",
  "pytest",
  "jest",
  "cypress",
  "playwright",
  "vitest",
  "storybook",
  "CI",
  "regression",
];

const NEGATIVE_TEST_PATTERNS = [
  "did not test",
  "didn't test",
  "not tested",
  "no test",
  "no tests",
  "did not run",
  "haven't run",
  "without tests",
];

const MODULARITY_KEYWORDS = [
  "refactor",
  "extract",
  "helper",
  "shared",
  "reuse",
  "deduplicate",
  "remove duplication",
  "DRY",
  "split",
  "module",
  "component",
];

const MAINTAINABILITY_KEYWORDS = [
  "cleanup",
  "simplify",
  "constant",
  "typing",
  "types",
  "migration",
  "backward compatible",
  "error handling",
  "validation",
  "observability",
  "deprecation",
  "reliability",
  "security",
];

const READABILITY_KEYWORDS = [
  "clarify",
  "rename",
  "simplify",
  "readable",
  "explicit",
  "description",
  "document",
  "docs",
];

export function rankEngineers(pullRequests, weights = DEFAULT_WEIGHTS) {
  const normalizedWeights = normalizeWeights(weights);
  const engineers = new Map();

  for (const pullRequest of pullRequests) {
    const login = pullRequest.user.login;
    const engineer = engineers.get(login) ?? createEngineer(login, pullRequest.user);
    const scoredPullRequest = scorePullRequest(pullRequest, normalizedWeights);

    engineer.pullRequests.push(scoredPullRequest);
    engineer.scoreTotal += scoredPullRequest.score;
    engineer.criteria.readability += scoredPullRequest.criteria.readability;
    engineer.criteria.modularity += scoredPullRequest.criteria.modularity;
    engineer.criteria.maintainability += scoredPullRequest.criteria.maintainability;
    engineer.criteria.testability += scoredPullRequest.criteria.testability;
    engineer.reasonCounts = mergeReasonCounts(engineer.reasonCounts, scoredPullRequest.reasons);
    engineers.set(login, engineer);
  }

  return Array.from(engineers.values())
    .map(finalizeEngineer)
    .sort((left, right) => right.impactScore - left.impactScore)
    .slice(0, 5);
}

export function scorePullRequest(pullRequest, weights = DEFAULT_WEIGHTS) {
  const normalizedWeights = normalizeWeights(weights);
  const title = pullRequest.title ?? "";
  const body = pullRequest.body ?? "";
  const text = `${title}\n${body}`;
  const labels = (pullRequest.labels ?? []).map((label) => label.name).join(" ");
  const reasons = [];

  const criteria = {
    readability: scoreReadability({ title, body, text, labels, reasons }),
    modularity: scoreModularity({ text, labels, reasons }),
    maintainability: scoreMaintainability({ title, text, labels, reasons }),
    testability: scoreTestability({ body, text, reasons }),
  };

  const weightedScore =
    criteria.readability * normalizedWeights.readability +
    criteria.modularity * normalizedWeights.modularity +
    criteria.maintainability * normalizedWeights.maintainability +
    criteria.testability * normalizedWeights.testability;

  return {
    number: pullRequest.number,
    displayId: pullRequest.displayId,
    title,
    url: pullRequest.html_url,
    mergedAt: pullRequest.pull_request?.merged_at,
    score: Math.round(weightedScore),
    criteria,
    reasons: Array.from(new Set(reasons)).slice(0, 5),
  };
}

export function normalizeWeights(weights = DEFAULT_WEIGHTS) {
  const total = Object.values(weights).reduce((sum, value) => sum + Number(value), 0);

  if (total === 0) {
    return normalizeWeights(DEFAULT_WEIGHTS);
  }

  return Object.fromEntries(
    Object.entries(DEFAULT_WEIGHTS).map(([key]) => [key, Number(weights[key] ?? DEFAULT_WEIGHTS[key]) / total]),
  );
}

function scoreReadability({ title, body, text, labels, reasons }) {
  let score = 35;

  if (/^(feat|fix|chore|refactor|docs|test|perf)\([^)]+\):\s+\S/.test(title)) {
    score += 18;
    reasons.push("uses a scoped, readable PR title");
  }

  if (hasSection(body, "Problem") && hasSection(body, "Changes")) {
    score += 25;
    reasons.push("explains both the problem and the change");
  }

  if (body.length > 400) {
    score += 8;
  }

  if (containsAny(text, READABILITY_KEYWORDS) || labels.includes("docs")) {
    score += 12;
    reasons.push("shows explicit readability or documentation work");
  }

  return clamp(score);
}

function scoreModularity({ text, labels, reasons }) {
  let score = 35;

  if (containsAny(text, MODULARITY_KEYWORDS) || labels.includes("refactor")) {
    score += 35;
    reasons.push("contains modularity, extraction, or deduplication signals");
  }

  if (/component|hook|service|command|model|schema|workflow/i.test(text)) {
    score += 12;
  }

  if (/only|targeted|small|focused|no schema|no behavior change/i.test(text)) {
    score += 10;
    reasons.push("keeps the change focused");
  }

  return clamp(score);
}

function scoreMaintainability({ title, text, labels, reasons }) {
  let score = 35;

  if (/^(fix|refactor|perf|chore)\b/.test(title)) {
    score += 12;
  }

  if (containsAny(text, MAINTAINABILITY_KEYWORDS) || /bug|crash|failure|invalid|stale/i.test(text)) {
    score += 32;
    reasons.push("improves maintainability or reliability");
  }

  if (/migration|backward compatible|existing|unchanged|fallback|edge case/i.test(text)) {
    score += 14;
    reasons.push("mentions compatibility or edge-case handling");
  }

  if (/security|permissions|validation|error/i.test(`${text} ${labels}`)) {
    score += 10;
  }

  return clamp(score);
}

function scoreTestability({ body, text, reasons }) {
  let score = 25;

  if (hasSection(body, "How did you test this code?")) {
    score += 20;
    reasons.push("includes a testing section");
  }

  if (containsAny(text, TEST_KEYWORDS)) {
    score += 35;
    reasons.push("references concrete automated or regression testing");
  }

  if (/manual test|verified|confirmed|reproduced/i.test(text)) {
    score += 12;
  }

  if (containsAny(text, NEGATIVE_TEST_PATTERNS)) {
    score -= 22;
    reasons.push("testing evidence is limited");
  }

  return clamp(score);
}

function finalizeEngineer(engineer) {
  const pullRequestCount = engineer.pullRequests.length;
  const averageScore = engineer.scoreTotal / pullRequestCount;
  const confidenceBoost = Math.min(10, Math.log2(pullRequestCount + 1) * 4);
  const impactScore = Math.round(averageScore * 0.88 + confidenceBoost);
  const topPullRequests = [...engineer.pullRequests].sort((left, right) => right.score - left.score).slice(0, 3);

  return {
    ...engineer,
    impactScore,
    pullRequestCount,
    criteria: {
      readability: Math.round(engineer.criteria.readability / pullRequestCount),
      modularity: Math.round(engineer.criteria.modularity / pullRequestCount),
      maintainability: Math.round(engineer.criteria.maintainability / pullRequestCount),
      testability: Math.round(engineer.criteria.testability / pullRequestCount),
    },
    topReasons: Object.entries(engineer.reasonCounts)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 3)
      .map(([reason]) => reason),
    topPullRequests,
  };
}

function createEngineer(login, user) {
  return {
    login,
    avatarUrl: user.avatar_url,
    profileUrl: user.html_url,
    pullRequests: [],
    scoreTotal: 0,
    criteria: {
      readability: 0,
      modularity: 0,
      maintainability: 0,
      testability: 0,
    },
    reasonCounts: {},
  };
}

function mergeReasonCounts(reasonCounts, reasons) {
  const nextReasonCounts = { ...reasonCounts };

  for (const reason of reasons) {
    nextReasonCounts[reason] = (nextReasonCounts[reason] ?? 0) + 1;
  }

  return nextReasonCounts;
}

function containsAny(text, keywords) {
  const normalizedText = text.toLowerCase();
  return keywords.some((keyword) => normalizedText.includes(keyword.toLowerCase()));
}

function hasSection(body, heading) {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\n)#{1,3}\\s*${escapedHeading}`, "i").test(body);
}

function clamp(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}
