import { useAction, useSubmission } from "@solidjs/router";
import { For, Show } from "solid-js";
import CollapsibleSection from "~/components/CollapsibleSection";
import { toggleAssess } from "~/lib/dashboard";
import type { AssessControlValue, RepoCardView } from "~/lib/dashboard-queries";

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

function formatDate(value: Date | null): string {
  return value ? dateFormat.format(value) : "";
}

function meterColor(pct: number | null): string {
  if (pct == null) return "var(--ink-3)";
  if (pct >= 80) return "var(--good)";
  if (pct >= 40) return "var(--warn)";
  return "var(--crit)";
}

export default function RepoCard(props: { repo: RepoCardView }) {
  const toggle = useAction(toggleAssess);
  const submission = useSubmission(toggleAssess, (input) => input[0] === props.repo.repoId);

  async function handleAssessChange(value: AssessControlValue) {
    try {
      await toggle(props.repo.repoId, value);
    } catch (err) {
      alert(`Couldn't update assess state: ${(err as Error).message}`);
    }
  }

  const shortName = () => props.repo.fullName.split("/")[1];
  const assessment = () => props.repo.assessment;

  return (
    <article class="repo" classList={{ "is-ignored": props.repo.isIgnored }}>
      <div class="repo-head">
        <div class="toprow">
          <h2>
            <a href={`https://github.com/${props.repo.fullName}`} target="_blank" rel="noopener">
              {shortName()}
            </a>
          </h2>
          <div class="badges">
            <span class="badge" classList={{ private: props.repo.isPrivate }}>
              {props.repo.isPrivate ? "private" : "public"}
            </span>
            <Show when={props.repo.language}>
              <span class="lang">{props.repo.language}</span>
            </Show>
          </div>
          <div class="assess-group">
            <span class="assess-label">Assess:</span>
            <div class="assess-control" role="radiogroup" aria-label="Assess status">
              <For each={["auto", "yes", "no"] as const}>
                {(value) => (
                  <label classList={{ active: props.repo.assessControl === value }}>
                    <input
                      type="radio"
                      name={`assess-${props.repo.repoId}`}
                      checked={props.repo.assessControl === value}
                      disabled={submission.pending}
                      onChange={() => handleAssessChange(value)}
                    />
                    {value === "auto" ? "Auto" : value === "yes" ? "Yes" : "No"}
                  </label>
                )}
              </For>
            </div>
            <Show when={props.repo.ignoreReasons.length > 0}>
              <span class="assess-reason">auto: {props.repo.ignoreReasons.join(", ")}</span>
            </Show>
          </div>
        </div>
        <Show when={props.repo.description}>
          <p class="desc">{props.repo.description}</p>
        </Show>
        <div class="meter-row">
          <span class={`status-chip s-${assessment().band}`}>{assessment().label}</span>
          <div
            class="meter"
            role="img"
            aria-label={`Estimated completion ${
              assessment().pct == null ? "not measurable" : `${assessment().pct} percent`
            }`}
          >
            <div
              style={{
                width: `${assessment().pct ?? 0}%`,
                background: meterColor(assessment().pct),
              }}
            />
          </div>
          <span class="meter-pct">{assessment().pct == null ? "n/a" : `${assessment().pct}%`}</span>
        </div>
      </div>
      <div class="assess">
        <div class="eyebrow">AI assessment — stated goals vs. reality</div>
        <p>{assessment().text}</p>
        <Show when={assessment().gaps.length > 0}>
          <ul>
            <For each={assessment().gaps}>{(gap) => <li>{gap}</li>}</For>
          </ul>
        </Show>
      </div>
      <div class="raw">
        <CollapsibleSection title="Commits" count={String(props.repo.commits.length)}>
          <Show when={props.repo.commits.length > 0} fallback={<div class="empty">No commits recorded.</div>}>
            <table class="log">
              <For each={props.repo.commits}>
                {(commit) => (
                  <tr>
                    <td class="date">{formatDate(commit.authoredAt)}</td>
                    <td class="sha">{commit.sha}</td>
                    <td class="msg">{commit.message}</td>
                  </tr>
                )}
              </For>
            </table>
          </Show>
        </CollapsibleSection>
        <CollapsibleSection title="Pull requests" count={String(props.repo.pullRequests.length)}>
          <Show
            when={props.repo.pullRequests.length > 0}
            fallback={<div class="empty">No PRs opened or merged.</div>}
          >
            <table class="log">
              <For each={props.repo.pullRequests}>
                {(pr) => (
                  <tr>
                    <td class="date">{formatDate(pr.createdAt)}</td>
                    <td class={`pr-state ${pr.mergedAt ? "merged" : pr.state}`}>
                      #{pr.number} {pr.mergedAt ? "merged" : pr.state}
                    </td>
                    <td class="msg">{pr.title}</td>
                  </tr>
                )}
              </For>
            </table>
          </Show>
        </CollapsibleSection>
        <CollapsibleSection title="Issues" count={String(props.repo.issues.length)}>
          <Show when={props.repo.issues.length > 0} fallback={<div class="empty">No issue activity.</div>}>
            <table class="log">
              <For each={props.repo.issues}>
                {(issue) => (
                  <tr>
                    <td class="date">{formatDate(issue.createdAt)}</td>
                    <td class={`pr-state ${issue.state}`}>
                      #{issue.number} {issue.state}
                    </td>
                    <td class="msg">{issue.title}</td>
                  </tr>
                )}
              </For>
            </table>
          </Show>
        </CollapsibleSection>
        <CollapsibleSection
          title="README"
          count={props.repo.assessment.readmeText ? `${props.repo.assessment.readmeText.length} chars` : "missing"}
        >
          <Show
            when={props.repo.assessment.readmeText}
            fallback={<div class="empty">Not yet assessed — no README captured.</div>}
          >
            <pre class="readme">{props.repo.assessment.readmeText}</pre>
          </Show>
        </CollapsibleSection>
      </div>
    </article>
  );
}
