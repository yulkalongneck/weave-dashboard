# PostHog Engineer Impact Dashboard

Small static dashboard for ranking the top five engineers in `yulkalongneck/posthog` by quality-focused PR signals.

## Run

```sh
npm start
```

Then open `http://localhost:5173`.

The dashboard does not read local data files for rankings. Click **Fetch live data** to pull the current GitHub API data directly.

For fastest live fetches, provide a valid GitHub token. Token-backed requests use GraphQL and ask only for the fields used by the impact model. Without a token, the app falls back to REST payloads.

## Gather Data

```sh
npm run collect:data
```

This writes:

- `data/posthog-engineer-impact-90d.json`

Set `GITHUB_TOKEN` before running the command for a faster full collection:

```sh
GITHUB_TOKEN=... npm run collect:data
```

## Notes

- Data is fetched directly from GitHub for `yulkalongneck/posthog`.
- Token-backed live fetches use GraphQL essential fields; no-token live fetches use REST.
- The fetcher recursively splits date windows and fully pages each window, avoiding GitHub Search's 1,000-result cap.
- If the fork has no merged PR records in the selected window, the dashboard falls back to fully paged recent commits from the same repo.
- The default and minimum lookback is 90 days.
- The model excludes lines changed, commits, and raw commit volume.
- A GitHub token is optional, but useful for full collection because this repository has high PR volume.
- The score is heuristic scaffolding. It should be treated as a transparent starting point, not a final performance metric.
