import { describe, expect, it } from "vitest";
import { fantasyReportFor } from "../src/fantasy";

const actionAt = (value: string) => fantasyReportFor(Date.parse(value));

describe("fantasyReportFor", () => {
  it.each([
    ["2026-01-06T13:00:00Z", "weekly-recap", "fantasy:weekly-recap:2026-01-06"],
    ["2026-01-06T23:00:00Z", "waivers", "fantasy:waivers:2026-01-06"],
    ["2026-08-05T12:00:00Z", "power-rankings", "fantasy:power-rankings:2026-08-05"],
    ["2026-08-06T23:00:00Z", "matchup-preview", "fantasy:matchup-preview:2026-08-06"],
    ["2026-08-09T12:00:00Z", "injury-watch", "fantasy:injury-watch:2026-08-09"],
    ["2026-08-09T20:00:00Z", "score-update-sunday-afternoon", "fantasy:score-update-sunday-afternoon:2026-08-09"],
    ["2026-08-10T00:00:00Z", "score-update-sunday-evening", "fantasy:score-update-sunday-evening:2026-08-09"],
    ["2026-08-10T12:00:00Z", "score-update-monday-morning", "fantasy:score-update-monday-morning:2026-08-10"],
  ] as const)("maps %s to %s", (time, kind, occurrenceKey) => {
    expect(actionAt(time)).toEqual({ kind, occurrenceKey });
  });

  it("maps daylight-saving hours and following-hour retries to the same occurrence", () => {
    expect(actionAt("2026-01-06T14:00:00Z")).toEqual({ kind: "weekly-recap", occurrenceKey: "fantasy:weekly-recap:2026-01-06" });
    expect(actionAt("2026-08-07T00:00:00Z")).toEqual({ kind: "matchup-preview", occurrenceKey: "fantasy:matchup-preview:2026-08-06" });
  });

  it.each(["2026-08-04T14:30:00Z", "2026-08-04T16:00:00Z", "2026-08-04T18:00:00Z", "2026-08-04T20:00:00Z"]) (
    "does not schedule outside configured hours (%s)", (time) => expect(actionAt(time)).toBeUndefined(),
  );
});
