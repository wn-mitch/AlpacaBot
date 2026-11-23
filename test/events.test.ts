import { describe, expect, it } from "vitest";
import { actionFor, type Env } from "../src/events";

const env = {
  DISCORD_BOT_TOKEN: "test-token",
  PICKLEBALL_CHANNEL_ID: "pickleball-channel",
  PICKLEBALL_ROLE_ID: "pickleball-role",
  TRIVIA_CHANNEL_ID: "trivia-channel",
  TRIVIA_ROLE_ID: "trivia-role",
  BOARD_GAME_CHANNEL_ID: "board-game-channel",
  BOARD_GAME_ROLE_ID: "board-game-role",
} as Env;

function actionAt(time: string) {
  return actionFor(Date.parse(time), env);
}

describe("actionFor", () => {
  it.each([
    ["2026-08-04T14:00:00Z", "announce", "board-game-night:2026-08-04"],
    ["2026-01-06T15:00:00Z", "announce", "board-game-night:2026-01-06"],
    ["2026-08-04T22:00:00Z", "rollup", "board-game-night:2026-08-04"],
    ["2026-01-06T23:00:00Z", "rollup", "board-game-night:2026-01-06"],
  ] as const)("selects board-game %s as %s", (time, kind, occurrenceKey) => {
    const action = actionAt(time);

    expect(action).toMatchObject({
      kind,
      occurrenceKey,
      event: {
        id: "board-game-night",
        title: "Weekly Board Game Night",
        description: "Board Game Night @ Tue. 7pm. You in?",
        channelId: "board-game-channel",
        roleId: "board-game-role",
      },
    });
  });

  it("does not schedule a nearby local hour", () => {
    expect(actionAt("2026-08-04T15:00:00Z")).toBeUndefined();
  });

  it("announces trivia at 10 AM Eastern Time", () => {
    expect(actionAt("2026-08-06T14:00:00Z")).toMatchObject({
      kind: "announce",
      occurrenceKey: "trivia:2026-08-06",
    });
    expect(actionAt("2026-01-01T15:00:00Z")).toMatchObject({
      kind: "announce",
      occurrenceKey: "trivia:2026-01-01",
    });
  });

  it("selects pickleball and trivia roll-ups", () => {
    expect(actionAt("2026-08-05T22:00:00Z")).toMatchObject({
      kind: "rollup",
      occurrenceKey: "pickleball-event:2026-08-05",
    });
    expect(actionAt("2026-08-06T22:00:00Z")).toMatchObject({
      kind: "rollup",
      occurrenceKey: "trivia:2026-08-06",
    });
  });

  it("never creates a roll-up for the Sunday ticket reminder", () => {
    expect(actionAt("2026-08-09T19:00:00Z")).toMatchObject({
      kind: "announce",
      occurrenceKey: "pickleball-ticket:2026-08-09",
    });
    expect(actionAt("2026-08-09T22:00:00Z")).toBeUndefined();
  });
});
