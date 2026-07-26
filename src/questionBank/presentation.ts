export function formatAttemptDate(answeredAt: string | null) {
  if (!answeredAt) return "学習日不明";
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(answeredAt));
}
