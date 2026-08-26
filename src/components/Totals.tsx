import { For } from "solid-js";
import type { DashboardTotals } from "~/lib/dashboard-queries";

export default function Totals(props: { totals: DashboardTotals }) {
  const tiles = () =>
    [
      [props.totals.repoCount, "active repos"],
      [props.totals.privateCount, "private"],
      [props.totals.commitCount, "commits"],
      [
        `${props.totals.mergedPrCount}/${props.totals.prCount}`,
        "PRs merged/opened",
      ],
      [props.totals.issueCount, "issues touched"],
    ] as const;

  return (
    <div class="totals">
      <For each={tiles()}>
        {([n, l]) => (
          <div class="tile">
            <div class="n">{n}</div>
            <div class="l">{l}</div>
          </div>
        )}
      </For>
    </div>
  );
}
