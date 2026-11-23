import { easternTimeParts } from "./schedule";

export interface Env {
  DISCORD_BOT_TOKEN: string;
  PICKLEBALL_CHANNEL_ID: string;
  PICKLEBALL_ROLE_ID: string;
  TRIVIA_CHANNEL_ID: string;
  TRIVIA_ROLE_ID: string;
  BOARD_GAME_CHANNEL_ID: string;
  BOARD_GAME_ROLE_ID?: string;
  ATTENDANCE_LEDGER: DurableObjectNamespace;
  FANTASY_CHANNEL_ID: string;
  SLEEPER_LEAGUE_ID: string;
  FANTASY_LEDGER: DurableObjectNamespace;
  AI: Ai;
}

export interface PollResponse {
  emoji: string;
  label: string;
}

export interface ScheduledEvent {
  id: "pickleball-ticket" | "pickleball-event" | "trivia" | "board-game-night";
  weekday: "Sunday" | "Tuesday" | "Wednesday" | "Thursday";
  announceHour: number;
  rollupHour?: number;
  title: string;
  description: string;
  channelId: string;
  roleId?: string;
  responses: readonly PollResponse[];
}

export type ScheduledAction =
  | { kind: "announce"; event: ScheduledEvent; occurrenceKey: string }
  | { kind: "rollup"; event: ScheduledEvent; occurrenceKey: string };

const standardResponses = [
  { emoji: "👍", label: "Yes!" },
  { emoji: "👎", label: "No" },
  { emoji: "❓", label: "Maybe" },
  { emoji: "⌛", label: "I'll be late" },
] as const;

const ticketResponses = [
  { emoji: "🎟️", label: "Bought Ticket" },
  { emoji: "👎", label: "No" },
  { emoji: "❓", label: "Maybe" },
] as const;


type EventTemplate = Omit<ScheduledEvent, "channelId" | "roleId"> & {
  channel: keyof Pick<
    Env,
    "PICKLEBALL_CHANNEL_ID" | "TRIVIA_CHANNEL_ID" | "BOARD_GAME_CHANNEL_ID"
  >;
  role?: keyof Pick<Env, "PICKLEBALL_ROLE_ID" | "TRIVIA_ROLE_ID" | "BOARD_GAME_ROLE_ID">;
};

const eventTemplates: readonly EventTemplate[] = [
  {
    id: "pickleball-ticket",
    weekday: "Sunday",
    announceHour: 15,
    title: "Weekly Pickleball Ticket Reminder",
    description:
      "Buy your pickleball ticket here: https://www.pickleballsocialclubatl.com/event-details",
    channel: "PICKLEBALL_CHANNEL_ID",
    role: "PICKLEBALL_ROLE_ID",
    responses: ticketResponses,
  },
  {
    id: "pickleball-event",
    weekday: "Wednesday",
    announceHour: 15,
    rollupHour: 18,
    title: "Weekly Pickleball Event Reminder",
    description: "Pickelball Social Club (Peachtree Hills) @ Wed. 7pm. You in?",
    channel: "PICKLEBALL_CHANNEL_ID",
    role: "PICKLEBALL_ROLE_ID",
    responses: standardResponses,
  },
  {
    id: "trivia",
    weekday: "Thursday",
    announceHour: 10,
    rollupHour: 18,
    title: "Weekly Trivia",
    description: "Neighbors (Virginia Highlands) @ 7:30pm. You in?",
    channel: "TRIVIA_CHANNEL_ID",
    role: "TRIVIA_ROLE_ID",
    responses: standardResponses,
  },
  {
    id: "board-game-night",
    weekday: "Tuesday",
    announceHour: 10,
    rollupHour: 18,
    title: "Weekly Board Game Night",
    description: "Board Game Night @ Tue. 7pm. You in?",
    channel: "BOARD_GAME_CHANNEL_ID",
    role: "BOARD_GAME_ROLE_ID",
    responses: standardResponses,
  },
];


function eventFor(template: EventTemplate, env: Env): ScheduledEvent {
  const channelId = env[template.channel];
  if (!channelId) {
    throw new Error(`Missing required binding: ${template.channel}`);
  }

  const roleId = template.role === undefined ? undefined : env[template.role];
  return {
    id: template.id,
    weekday: template.weekday,
    announceHour: template.announceHour,
    rollupHour: template.rollupHour,
    title: template.title,
    description: template.description,
    channelId,
    ...(roleId ? { roleId } : {}),
    responses: template.responses,
  };
}

export function actionFor(scheduledTime: number, env: Env): ScheduledAction | undefined {
  const parts = easternTimeParts(scheduledTime);
  if (parts.minute !== "00") {
    return undefined;
  }

  const hour = Number(parts.hour);
  const template = eventTemplates.find(
    (event) =>
      event.weekday === parts.weekday &&
      (event.announceHour === hour || event.rollupHour === hour),
  );
  if (template === undefined) {
    return undefined;
  }

  const event = eventFor(template, env);
  const occurrenceKey = `${event.id}:${parts.year}-${parts.month}-${parts.day}`;
  return event.announceHour === hour
    ? { kind: "announce", event, occurrenceKey }
    : { kind: "rollup", event, occurrenceKey };
}
