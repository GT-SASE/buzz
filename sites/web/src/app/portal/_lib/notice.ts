/** What an officer's change sent: the `notice` the API returns after one. */
export type Notice = {
  sent: number;
  failed: number;
  skipped: number;
  channel: "posted" | "failed" | "off";
};

/**
 * One toast for a change and the messages that went with it. The change is
 * saved whatever happened, so a failed send is a warning that says what to do
 * by hand, never an error.
 *
 * `unit` is what one send is called ("email", "calendar update"), `audience`
 * who got it, and `followUp` what the officer does for a send that failed.
 */
export function noticeToast(
  notice: Notice,
  {
    done,
    unit,
    audience,
    followUp,
  }: { done: string; unit: string; audience: string; followUp: string },
) {
  const parts = [done];
  const total = notice.sent + notice.failed;
  const plural = (count: number, word: string) =>
    count === 1 ? word : `${word}s`;
  let kind: "success" | "warning" = "success";

  if (notice.failed > 0) {
    kind = "warning";
    parts.push(
      `${notice.failed} of ${total} ${plural(total, unit)} did not send. ${followUp}`,
    );
  } else if (notice.sent > 0) {
    parts.push(
      `${notice.sent} ${plural(notice.sent, unit)} sent to ${audience}.`,
    );
  }
  if (notice.skipped > 0) {
    parts.push(`${notice.skipped} opted out of these emails.`);
  }
  if (notice.channel === "failed") {
    kind = "warning";
    parts.push("The Discord post did not go through.");
  } else if (notice.channel === "posted") {
    parts.push("Posted to Discord.");
  }
  return { kind, message: parts.join(" ") };
}
