import { fetchRepositoryContributions } from "./githubApi.js";
import { rankEngineers } from "./impactModel.js";

const elements = {
  form: document.querySelector("#controls-form"),
  fetchButton: document.querySelector("#fetch-button"),
  lookbackDays: document.querySelector("#lookback-days"),
  githubToken: document.querySelector("#github-token"),
  includeContributors: document.querySelector("#include-contributors"),
  statusMessage: document.querySelector("#status-message"),
  analysisSummary: document.querySelector("#analysis-summary"),
  ranking: document.querySelector("#ranking"),
  weightInputs: Array.from(document.querySelectorAll("[data-weight]")),
};

let latestPullRequests = [];
let latestSourceType = "pullRequests";

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await fetchAndRenderRanking();
});

for (const input of elements.weightInputs) {
  input.addEventListener("input", () => {
    if (latestPullRequests.length > 0) {
      renderRanking(latestPullRequests);
    }
  });
}

renderEmptyState();

async function fetchAndRenderRanking() {
  setLoading(true);
  setStatus("Fetching live GitHub data for the selected date window...");

  try {
    const result = await fetchRepositoryContributions({
      lookbackDays: Number(elements.lookbackDays.value),
      token: elements.githubToken.value.trim(),
      includeContributors: elements.includeContributors.checked,
      onProgress: updateFetchProgress,
    });

    latestPullRequests = result.contributions;
    latestSourceType = result.sourceType;
    renderRanking(latestPullRequests, latestSourceType);
    elements.analysisSummary.textContent = buildSummary(result);
    setStatus(`GitHub API integration succeeded after ${result.requestCount} requests. Ranking is ready.`);
  } catch (error) {
    latestPullRequests = [];
    latestSourceType = "pullRequests";
    elements.analysisSummary.textContent = "";
    renderError(error);
    setStatus("Could not complete the GitHub fetch.");
  } finally {
    setLoading(false);
  }
}

function renderRanking(pullRequests, sourceType = latestSourceType) {
  const engineers = rankEngineers(pullRequests, readWeights());

  if (engineers.length === 0) {
    renderEmptyState("No eligible human-authored contributions were found for these filters.");
    return;
  }

  elements.ranking.innerHTML = engineers.map((engineer, index) => renderEngineerCard(engineer, index, sourceType)).join("");
}

function renderEngineerCard(engineer, index, sourceType) {
  const contributionLabel = sourceType === "commits" ? "commit" : "merged PR";
  const criteriaRows = Object.entries(engineer.criteria)
    .map(([name, value]) => renderScoreBar(name, value))
    .join("");
  const reasons = engineer.topReasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("");
  const contributionCount = engineer.pullRequestCount ?? engineer.contributionCount;
  const topContributions = engineer.topPullRequests ?? engineer.topContributions;
  const pullRequests = topContributions
    .map(
      (pullRequest) => `
        <li>
          <a href="${pullRequest.url}" target="_blank" rel="noreferrer">${escapeHtml(pullRequest.displayId ?? `#${pullRequest.number}`)} ${escapeHtml(pullRequest.title)}</a>
          <span>${pullRequest.score}</span>
        </li>
      `,
    )
    .join("");

  return `
    <article class="engineer-card">
      <div class="engineer-rank">${index + 1}</div>
      <div class="engineer-main">
        <header class="engineer-header">
          <img src="${engineer.avatarUrl}" alt="" width="56" height="56" />
          <div>
            <a class="engineer-name" href="${engineer.profileUrl}" target="_blank" rel="noreferrer">${escapeHtml(engineer.login)}</a>
            <p>${contributionCount} assessed ${contributionLabel}${contributionCount === 1 ? "" : "s"}</p>
          </div>
          <div class="impact-score">
            <span>${engineer.impactScore}</span>
            impact
          </div>
        </header>

        <div class="card-grid">
          <div class="criteria-list">
            ${criteriaRows}
          </div>

          <div>
            <h3>Why they rank here</h3>
            <ul class="reason-list">${reasons}</ul>
          </div>

          <div>
            <h3>Strongest evidence</h3>
            <ul class="pull-list">${pullRequests}</ul>
          </div>
        </div>
      </div>
    </article>
  `;
}

function renderScoreBar(name, value) {
  return `
    <div class="score-bar">
      <div class="score-bar-label">
        <span>${formatCriterionName(name)}</span>
        <span>${value}</span>
      </div>
      <div class="score-bar-track">
        <div class="score-bar-fill" style="width: ${value}%"></div>
      </div>
    </div>
  `;
}

function renderEmptyState(message = "Choose an analysis window, then fetch the PostHog PR data to rank the top five engineers.") {
  elements.ranking.innerHTML = `
    <div class="empty-state">
      <h2>No ranking yet</h2>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

function renderError(error) {
  elements.ranking.innerHTML = `
    <div class="empty-state error-state">
      <h2>GitHub fetch failed</h2>
      <p>${escapeHtml(error.message)}</p>
    </div>
  `;
}

function readWeights() {
  return Object.fromEntries(elements.weightInputs.map((input) => [input.dataset.weight, Number(input.value)]));
}

function setLoading(isLoading) {
  elements.fetchButton.disabled = isLoading;
  elements.fetchButton.textContent = isLoading ? "Fetching..." : "Fetch live data";
}

function setStatus(message) {
  elements.statusMessage.textContent = message;
}

function updateFetchProgress(progress) {
  if (progress.status === "rate-limited") {
    const target = progress.sourceType === "commits" ? `commit page ${progress.page}` : `${progress.startDate} through ${progress.endDate}`;
    setStatus(
      `GitHub rate limit reached; waiting ${Math.ceil(progress.waitMs / 1000)}s before continuing ${target}.`,
    );
    return;
  }

  if (progress.status === "commits-fetching") {
    setStatus(
      `No merged PRs found in this fork; fetching commits instead. ${progress.fetchedCount.toLocaleString()} commits fetched across ${progress.page} pages.`,
    );
    return;
  }

  if (progress.status === "graphql-commits-fetching") {
    setStatus(
      `No merged PRs found in this fork; fetching essential commit fields. ${progress.fetchedCount.toLocaleString()} of ${progress.totalCount.toLocaleString()} commits across ${progress.page} pages.`,
    );
    return;
  }

  if (progress.status === "graphql-scanned") {
    setStatus(
      `Scanned essential ${progress.sourceType} fields for ${progress.startDate} through ${progress.endDate}: ${progress.totalCount.toLocaleString()} matched; ${progress.requestCount} GraphQL requests so far.`,
    );
    return;
  }

  if (progress.status === "graphql-fetching") {
    setStatus(
      `Fetching essential ${progress.sourceType} fields for ${progress.startDate} through ${progress.endDate}: ${progress.fetchedCount.toLocaleString()} of ${progress.totalCount.toLocaleString()} items; ${progress.requestCount} GraphQL requests so far.`,
    );
    return;
  }

  if (progress.status === "scanned") {
    setStatus(
      `Scanning ${progress.startDate} through ${progress.endDate}: ${progress.totalCount.toLocaleString()} matched; ${progress.requestCount} requests so far.`,
    );
    return;
  }

  setStatus(
    `Fetching ${progress.startDate} through ${progress.endDate}: ${progress.fetchedCount.toLocaleString()} of ${progress.totalCount.toLocaleString()} PRs; ${progress.requestCount} requests so far.`,
  );
}

function buildSummary(result) {
  const source = result.dataSource === "graphql" ? "essential GraphQL fields" : "REST payloads";

  if (result.sourceType === "commits") {
    return `${result.contributions.length.toLocaleString()} eligible commits analyzed from ${result.mergedAfter} through ${result.mergedBefore}; 0 merged PRs were available in this fork; fetched via ${source}.`;
  }

  return `${result.contributions.length.toLocaleString()} eligible PRs analyzed from ${result.mergedAfter} through ${result.mergedBefore}; ${result.totalMatchingPullRequests.toLocaleString()} matched before filters across ${result.dateWindows.length} date windows; fetched via ${source}.`;
}

function formatCriterionName(name) {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
