import { Title } from "@solidjs/meta";
import { createAsync } from "@solidjs/router";
import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";
import RepoCard from "~/components/RepoCard";
import Totals from "~/components/Totals";
import { getDashboardData } from "~/lib/dashboard";
import { computeTotals, filterVisibleRepos } from "~/lib/dashboard-view";

export default function Home() {
  const data = createAsync(() => getDashboardData());

  const [hideIgnored, setHideIgnored] = createSignal(false);

  // Must run before the persisting effect below — Solid runs effects in creation order.
  onMount(() => {
    try {
      if (localStorage.getItem("hideIgnoredRepos") === "true") {
        setHideIgnored(true);
      }
    } catch {
      /* localStorage unavailable — preference just won't persist */
    }
  });

  createEffect(() => {
    try {
      localStorage.setItem("hideIgnoredRepos", String(hideIgnored()));
    } catch {
      /* localStorage unavailable — preference just won't persist */
    }
  });

  return (
    <div class="wrap">
      <Title>GitHub Project Tracker</Title>
      <header class="page">
        <h1>Project completion tracker</h1>
        <p class="sub">
          github.com/<code>sdpilon</code> · live from Postgres, refreshed by the enrichment pipeline
        </p>
        <div class="notice">
          Assessments are Claude's reading of each README's stated goals against actual commits, PRs, and
          issues — a judgment call about "stated scope shipped," not code coverage.
        </div>
      </header>

      <Show when={data()}>
        {(dashboard) => {
          const visibleRepos = createMemo(() => filterVisibleRepos(dashboard().repos, hideIgnored()));
          const visibleTotals = createMemo(() =>
            hideIgnored() ? computeTotals(visibleRepos()) : dashboard().totals,
          );

          return (
            <>
              <label class="hide-ignored-toggle">
                <input
                  type="checkbox"
                  checked={hideIgnored()}
                  onChange={(e) => setHideIgnored(e.currentTarget.checked)}
                />
                Hide ignored repos
              </label>
              <Totals totals={visibleTotals()} />
              <Show
                when={visibleRepos().length > 0}
                fallback={<p class="empty">No repos to show — everything is currently ignored.</p>}
              >
                <div id="repos">
                  <For each={visibleRepos()}>{(repo) => <RepoCard repo={repo} />}</For>
                </div>
              </Show>
            </>
          );
        }}
      </Show>

      <footer class="page">
        Percentages are judgment calls about "stated scope shipped," not code coverage. Ignored repos are
        excluded from AI assessment — use the Auto/Yes/No control on any repo to force it ignored, force it
        included, or hand it back to the automatic rules.
      </footer>
    </div>
  );
}
