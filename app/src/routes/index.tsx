import { Title } from "@solidjs/meta";
import { createAsync } from "@solidjs/router";
import { For, Show } from "solid-js";
import RepoCard from "~/components/RepoCard";
import Totals from "~/components/Totals";
import { getDashboardData } from "~/lib/dashboard";

export default function Home() {
  const data = createAsync(() => getDashboardData());

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
        {(dashboard) => (
          <>
            <Totals totals={dashboard().totals} />
            <div id="repos">
              <For each={dashboard().repos}>{(repo) => <RepoCard repo={repo} />}</For>
            </div>
          </>
        )}
      </Show>

      <footer class="page">
        Percentages are judgment calls about "stated scope shipped," not code coverage. Ignored repos are
        excluded from AI assessment — use the Auto/Yes/No control on any repo to force it ignored, force it
        included, or hand it back to the automatic rules.
      </footer>
    </div>
  );
}
