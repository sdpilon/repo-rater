import { describe, expect, it } from "vitest";
import {
  computeTotals,
  filterVisibleRepos,
  type RepoCardView,
} from "./dashboard-view";

function fakeRepoCardView(overrides: Partial<RepoCardView> = {}): RepoCardView {
  return {
    repoId: 1,
    fullName: "sdpilon/example",
    htmlUrl: null,
    description: null,
    language: null,
    isPrivate: false,
    isIgnored: false,
    ignoreReasons: [],
    assessControl: "auto",
    assessment: {
      pct: null,
      band: "none",
      label: "Not yet assessed",
      text: "",
      gaps: [],
      readmeText: null,
      updatedAt: null,
    },
    commits: [],
    issues: [],
    pullRequests: [],
    ...overrides,
  };
}

describe("computeTotals", () => {
  it("aggregates counts across repos", () => {
    const repos = [
      fakeRepoCardView({
        repoId: 1,
        isPrivate: true,
        commits: [{ sha: "a", authoredAt: null, message: null }],
      }),
      fakeRepoCardView({
        repoId: 2,
        pullRequests: [
          {
            number: 1,
            title: null,
            state: "open",
            createdAt: null,
            mergedAt: null,
          },
          {
            number: 2,
            title: null,
            state: "closed",
            createdAt: null,
            mergedAt: new Date(),
          },
        ],
        issues: [{ number: 1, title: null, state: "open", createdAt: null }],
      }),
    ];

    expect(computeTotals(repos)).toEqual({
      repoCount: 2,
      privateCount: 1,
      commitCount: 1,
      prCount: 2,
      mergedPrCount: 1,
      issueCount: 1,
    });
  });

  it("returns all zeros for an empty list", () => {
    expect(computeTotals([])).toEqual({
      repoCount: 0,
      privateCount: 0,
      commitCount: 0,
      prCount: 0,
      mergedPrCount: 0,
      issueCount: 0,
    });
  });
});

describe("filterVisibleRepos", () => {
  it("returns all repos unchanged when hideIgnored is false", () => {
    const repos = [
      fakeRepoCardView({ repoId: 1, isIgnored: false }),
      fakeRepoCardView({ repoId: 2, isIgnored: true }),
    ];

    expect(filterVisibleRepos(repos, false)).toEqual(repos);
  });

  it("returns only non-ignored repos when hideIgnored is true and repos are a mix", () => {
    const visible = fakeRepoCardView({ repoId: 1, isIgnored: false });
    const hidden = fakeRepoCardView({ repoId: 2, isIgnored: true });

    expect(filterVisibleRepos([visible, hidden], true)).toEqual([visible]);
  });

  it("returns an empty array when hideIgnored is true and all repos are ignored", () => {
    const repos = [
      fakeRepoCardView({ repoId: 1, isIgnored: true }),
      fakeRepoCardView({ repoId: 2, isIgnored: true }),
    ];

    expect(filterVisibleRepos(repos, true)).toEqual([]);
  });

  it("returns an empty array for empty input regardless of hideIgnored", () => {
    expect(filterVisibleRepos([], false)).toEqual([]);
    expect(filterVisibleRepos([], true)).toEqual([]);
  });
});
