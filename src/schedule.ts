export interface EasternTimeParts {
  year: string;
  month: string;
  day: string;
  weekday: string;
  hour: string;
  minute: string;
}

const easternTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "long",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function easternTimeParts(scheduledTime: number): EasternTimeParts {
  const parts = Object.fromEntries(
    easternTimeFormatter
      .formatToParts(new Date(scheduledTime))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    weekday: parts.weekday,
    hour: parts.hour,
    minute: parts.minute,
  };
}
