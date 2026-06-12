import {
  AutomoderatorFilterComment,
  AutomoderatorFilterPost,
  CommentReport,
  CommentSubmit,
  MessageData,
  ModAction,
  ModMail,
  PostReport,
  PostSubmit,
} from "@devvit/protos";
import { Devvit, JobContext, TriggerContext } from "@devvit/public-api";

const DISCORD_WEBHOOK_HOSTS = [
  "canary.discord.com",
  "ptb.discord.com",
  "discord.com",
  "canary.discordapp.com",
  "ptb.discordapp.com",
  "discordapp.com",
];

const SPECTRUM_BLUE = 0x005fff;
const PRIVATE_NOTE_GREEN = 0x00cc66;
const REPORTED_ORANGE = 0xff4500;
const AUTOMOD_YELLOW = 0xffcc00;
const POST_WHITE = 0xffffff;

const PREVIEW_LENGTH = 300;
const TITLE_LENGTH = 256;
const FIELD_LENGTH = 1024;
const REPORT_TIMEZONE = "America/New_York";
const REPORT_HOUR = 8;
const DAILY_REPORT_JOB_NAME = "dailyReport";
const DAILY_REPORT_KV_KEY = "dailyReport:data";
const DAILY_REPORT_CRON_KV_KEY = "dailyReport:cronJobId";
const DAILY_REPORT_SENT_KV_KEY = "dailyReport:lastSentDate";
const MONITORED_SUBREDDITS = ["spectrum", "spectrum_official"] as const;

const MOD_QUEUE_APPROVE_ACTIONS = new Set(["approvelink", "approvecomment"]);
const MOD_QUEUE_REMOVE_ACTIONS = new Set([
  "removelink",
  "removecomment",
  "spamlink",
  "spamcomment",
]);

type MonitoredSubreddit = (typeof MONITORED_SUBREDDITS)[number];
type WebhookCategory = "modmail" | "modqueue" | "newposts";

type SubredditMetrics = {
  modmailReceived: number;
  newPostsSubmitted: number;
  modQueueFlagged: number;
  postsWithModResponse: number;
  postsWithoutModResponse: number;
  modmailResponseTimeTotalMs: number;
  modmailResponseTimeSamples: number;
  postResponseTimeTotalMs: number;
  postResponseTimeSamples: number;
  modmailResolved: number;
  modmailUnresolved: number;
  modmailAbandoned: number;
  modQueueApproved: number;
  modQueueRemoved: number;
  postsLive: number;
  postsRemoved: number;
};

type ModmailConversationTracking = {
  subreddit: MonitoredSubreddit;
  firstUserMessageAt: number;
  lastUserMessageAt: number;
  lastModReplyAt: number | null;
  modReplied: boolean;
  resolved: boolean;
};

type PostTracking = {
  subreddit: MonitoredSubreddit;
  submittedAt: number;
  hasModResponse: boolean;
  isLive: boolean;
};

type DailyReportStore = {
  periodStartedAt: string;
  subreddits: Record<MonitoredSubreddit, SubredditMetrics>;
  modmailConversations: Record<string, ModmailConversationTracking>;
  trackedPosts: Record<string, PostTracking>;
};

type DiscordEmbedField = {
  name: string;
  value: string;
  inline?: boolean;
};

type DiscordEmbed = {
  title?: string;
  url?: string;
  description?: string;
  author?: {
    name: string;
    url?: string;
  };
  fields?: DiscordEmbedField[];
  color?: number;
  timestamp?: string;
  footer?: {
    text: string;
  };
};

type DiscordWebhookPayload = {
  content?: string;
  embeds: DiscordEmbed[];
};

Devvit.configure({
  http: true,
  redditAPI: true,
  kvStore: true,
});

Devvit.addSettings([
  {
    type: "string",
    name: "spectrumModmailWebhook",
    label: "Webhook URL for r/Spectrum modmail alerts",
  },
  {
    type: "string",
    name: "spectrumOfficialModmailWebhook",
    label: "Webhook URL for r/Spectrum_Official modmail alerts",
  },
  {
    type: "string",
    name: "spectrumModQueueWebhook",
    label: "Webhook URL for r/Spectrum mod queue alerts",
  },
  {
    type: "string",
    name: "spectrumOfficialModQueueWebhook",
    label: "Webhook URL for r/Spectrum_Official mod queue alerts",
  },
  {
    type: "string",
    name: "spectrumNewPostsWebhook",
    label: "Webhook URL for r/Spectrum new posts alerts",
  },
  {
    type: "string",
    name: "spectrumOfficialNewPostsWebhook",
    label: "Webhook URL for r/Spectrum_Official new posts alerts",
  },
  {
    type: "string",
    name: "reportingWebhook",
    label: "Webhook URL for the shared daily reporting channel",
  },
  {
    type: "boolean",
    name: "outgoing",
    label:
      "Whether to send outgoing messages by mods to the webhook payload (Enabled by default, if disabled outgoing messages by mods will not be sent to the webhook payload.)",
    defaultValue: true,
  },
  {
    type: "string",
    name: "ignoreUsers",
    label: "Ignore list (comma-separated usernames, don't include u/)",
    helpText:
      "Add Reddit usernames (case-insensitive) separated by commas to skip them from webhook payloads (example: username1, username2, username3). This is totally optional.",
  },
  {
    type: "string",
    name: "rolePing",
    label: "Discord Role ID to Ping",
    helpText:
      "Enter a Discord Role ID to ping when a message is sent. Leave blank to disable. This is totally optional.",
  },
  {
    type: "boolean",
    name: "onlyModDiscussions",
    label: "Only Sync Mod Discussions",
    helpText:
      "If enabled, only mod discussion messages will be sent to the webhook. Messages from users will be ignored.",
    defaultValue: false,
  },
]);

Devvit.addTrigger({
  event: "ModMail",
  onEvent: async (event: ModMail, context: TriggerContext) => {
    try {
      if (!context) {
        throw new Error("Context is probably undefined");
      }
      await trackModMailForReport(event, context);
      await sendModMailToWebhook(event, context);
    } catch (error) {
      console.error(
        "ModMail trigger error:",
        error instanceof Error ? error.message : String(error)
      );
    }
  },
});

Devvit.addTrigger({
  events: [
    "PostReport",
    "CommentReport",
    "AutomoderatorFilterPost",
    "AutomoderatorFilterComment",
  ],
  onEvent: async (event, context: TriggerContext) => {
    try {
      if (!context) {
        throw new Error("Context is probably undefined");
      }

      await trackModQueueForReport(event, context);

      switch (event.type) {
        case "PostReport":
          await sendModQueueAlertFromPostReport(event, context);
          break;
        case "CommentReport":
          await sendModQueueAlertFromCommentReport(event, context);
          break;
        case "AutomoderatorFilterPost":
          await sendModQueueAlertFromAutomodPost(event, context);
          break;
        case "AutomoderatorFilterComment":
          await sendModQueueAlertFromAutomodComment(event, context);
          break;
        default:
          console.error("Unhandled mod queue event type");
      }
    } catch (error) {
      console.error(
        "Mod queue trigger error:",
        error instanceof Error ? error.message : String(error)
      );
    }
  },
});

Devvit.addTrigger({
  event: "PostSubmit",
  onEvent: async (event: PostSubmit, context: TriggerContext) => {
    try {
      if (!context) {
        throw new Error("Context is probably undefined");
      }
      await trackPostSubmitForReport(event, context);
      await sendNewPostAlert(event, context);
    } catch (error) {
      console.error(
        "PostSubmit trigger error:",
        error instanceof Error ? error.message : String(error)
      );
    }
  },
});

Devvit.addTrigger({
  event: "CommentSubmit",
  onEvent: async (event: CommentSubmit, context: TriggerContext) => {
    try {
      if (!context) {
        throw new Error("Context is probably undefined");
      }
      await trackCommentSubmitForReport(event, context);
    } catch (error) {
      console.error(
        "CommentSubmit trigger error:",
        error instanceof Error ? error.message : String(error)
      );
    }
  },
});

Devvit.addTrigger({
  event: "ModAction",
  onEvent: async (event: ModAction, context: TriggerContext) => {
    try {
      if (!context) {
        throw new Error("Context is probably undefined");
      }
      await trackModActionForReport(event, context);
    } catch (error) {
      console.error(
        "ModAction trigger error:",
        error instanceof Error ? error.message : String(error)
      );
    }
  },
});

Devvit.addSchedulerJob({
  name: DAILY_REPORT_JOB_NAME,
  onRun: async (_event, context: JobContext) => {
    try {
      await maybeSendDailyReport(context);
    } catch (error) {
      console.error(
        "Daily report scheduler error:",
        error instanceof Error ? error.message : String(error)
      );
    }
  },
});

Devvit.addTrigger({
  events: ["AppInstall", "AppUpgrade"],
  onEvent: async (_event, context: TriggerContext) => {
    try {
      if (!context) {
        throw new Error("Context is probably undefined");
      }
      await ensureDailyReportScheduled(context);
    } catch (error) {
      console.error(
        "App install/upgrade scheduling error:",
        error instanceof Error ? error.message : String(error)
      );
    }
  },
});

function truncateDescription(description: string, maxLength: number = 4096): string {
  if (description.length <= maxLength) {
    return description;
  }
  const truncationIndicator = "... (truncated)";
  return description.substring(0, maxLength - truncationIndicator.length) + truncationIndicator;
}

function truncateField(value: string): string {
  return truncateDescription(value, FIELD_LENGTH);
}

function truncateTitle(value: string): string {
  return truncateDescription(value, TITLE_LENGTH);
}

function previewText(text: string, maxLength: number = PREVIEW_LENGTH): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.substring(0, maxLength)}...`;
}

function normalizeSubredditName(name: string): string {
  return name.replace(/^r\//i, "").trim().toLowerCase();
}

function isMonitoredSubreddit(subredditName: string): boolean {
  const normalized = normalizeSubredditName(subredditName);
  return normalized === "spectrum" || normalized === "spectrum_official";
}

function getWebhookSettingName(
  subredditName: string,
  category: WebhookCategory
): string | null {
  const normalized = normalizeSubredditName(subredditName);

  if (normalized === "spectrum") {
    switch (category) {
      case "modmail":
        return "spectrumModmailWebhook";
      case "modqueue":
        return "spectrumModQueueWebhook";
      case "newposts":
        return "spectrumNewPostsWebhook";
    }
  }

  if (normalized === "spectrum_official") {
    switch (category) {
      case "modmail":
        return "spectrumOfficialModmailWebhook";
      case "modqueue":
        return "spectrumOfficialModQueueWebhook";
      case "newposts":
        return "spectrumOfficialNewPostsWebhook";
    }
  }

  return null;
}

function isDiscordWebhook(webhook: string): boolean {
  return DISCORD_WEBHOOK_HOSTS.some((host) =>
    webhook.startsWith(`https://${host}/api/webhooks/`)
  );
}

function redditProfileUrl(username: string): string {
  return `https://www.reddit.com/u/${username}`;
}

function redditPermalinkUrl(permalink: string): string {
  if (permalink.startsWith("http")) {
    return permalink;
  }
  return `https://www.reddit.com${permalink}`;
}

function toPostId(id: string): string {
  return id.startsWith("t3_") ? id : `t3_${id}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getDateKeyInTimezone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function getLocalHour(date: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hour12: false,
  }).format(date);
  return Number.parseInt(hour, 10);
}

function displaySubredditLabel(subreddit: string): string {
  return subreddit === "spectrum_official" ? "r/Spectrum_Official" : "r/Spectrum";
}

function getMonitoredSubredditKey(subredditName: string): MonitoredSubreddit | null {
  const normalized = normalizeSubredditName(subredditName);
  if (normalized === "spectrum" || normalized === "spectrum_official") {
    return normalized;
  }
  return null;
}

function emptyMetrics(): SubredditMetrics {
  return {
    modmailReceived: 0,
    newPostsSubmitted: 0,
    modQueueFlagged: 0,
    postsWithModResponse: 0,
    postsWithoutModResponse: 0,
    modmailResponseTimeTotalMs: 0,
    modmailResponseTimeSamples: 0,
    postResponseTimeTotalMs: 0,
    postResponseTimeSamples: 0,
    modmailResolved: 0,
    modmailUnresolved: 0,
    modmailAbandoned: 0,
    modQueueApproved: 0,
    modQueueRemoved: 0,
    postsLive: 0,
    postsRemoved: 0,
  };
}

function createEmptyDailyReportStore(): DailyReportStore {
  return {
    periodStartedAt: new Date().toISOString(),
    subreddits: {
      spectrum: emptyMetrics(),
      spectrum_official: emptyMetrics(),
    },
    modmailConversations: {},
    trackedPosts: {},
  };
}

async function getDailyReportStore(context: JobContext | TriggerContext): Promise<DailyReportStore> {
  const stored = await context.kvStore.get<DailyReportStore>(DAILY_REPORT_KV_KEY);
  if (!stored?.subreddits) {
    return createEmptyDailyReportStore();
  }

  return {
    ...createEmptyDailyReportStore(),
    ...stored,
    subreddits: {
      spectrum: { ...emptyMetrics(), ...stored.subreddits.spectrum },
      spectrum_official: { ...emptyMetrics(), ...stored.subreddits.spectrum_official },
    },
    modmailConversations: stored.modmailConversations ?? {},
    trackedPosts: stored.trackedPosts ?? {},
  };
}

async function saveDailyReportStore(
  context: JobContext | TriggerContext,
  store: DailyReportStore
): Promise<void> {
  await context.kvStore.put(DAILY_REPORT_KV_KEY, store);
}

async function resetDailyReportStore(context: JobContext | TriggerContext): Promise<void> {
  await context.kvStore.put(DAILY_REPORT_KV_KEY, createEmptyDailyReportStore());
}

function getMetrics(store: DailyReportStore, subreddit: MonitoredSubreddit): SubredditMetrics {
  return store.subreddits[subreddit];
}

function formatDuration(ms: number): string {
  if (ms <= 0) {
    return "N/A";
  }

  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatAverageDuration(totalMs: number, samples: number): string {
  if (samples <= 0) {
    return "N/A";
  }
  return formatDuration(totalMs / samples);
}

function formatReportGeneratedAt(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: REPORT_TIMEZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function formatReportingPeriod(store: DailyReportStore, generatedAt: Date): string {
  const end = generatedAt.toISOString();
  return `${store.periodStartedAt} to ${end}`;
}

function finalizeModmailConversationMetrics(store: DailyReportStore): void {
  for (const subreddit of MONITORED_SUBREDDITS) {
    getMetrics(store, subreddit).modmailUnresolved = 0;
    getMetrics(store, subreddit).modmailAbandoned = 0;
  }

  for (const conversation of Object.values(store.modmailConversations)) {
    if (conversation.resolved) {
      continue;
    }

    const metrics = getMetrics(store, conversation.subreddit);
    if (!conversation.modReplied) {
      metrics.modmailUnresolved += 1;
      continue;
    }

    if (
      conversation.lastModReplyAt !== null &&
      conversation.lastModReplyAt >= conversation.lastUserMessageAt
    ) {
      metrics.modmailAbandoned += 1;
      continue;
    }

    metrics.modmailUnresolved += 1;
  }
}

function reconcilePostMetrics(store: DailyReportStore): void {
  for (const subreddit of MONITORED_SUBREDDITS) {
    const metrics = getMetrics(store, subreddit);
    metrics.postsWithModResponse = 0;
    metrics.postsWithoutModResponse = 0;
    metrics.postsLive = 0;
    metrics.postsRemoved = 0;
  }

  for (const post of Object.values(store.trackedPosts)) {
    const metrics = getMetrics(store, post.subreddit);
    if (post.hasModResponse) {
      metrics.postsWithModResponse += 1;
    } else {
      metrics.postsWithoutModResponse += 1;
    }

    if (post.isLive) {
      metrics.postsLive += 1;
    } else {
      metrics.postsRemoved += 1;
    }
  }
}

function buildSubredditReportFields(
  subreddit: MonitoredSubreddit,
  metrics: SubredditMetrics
): DiscordEmbedField[] {
  const label = displaySubredditLabel(subreddit);

  return [
    {
      name: `${label} — New Modmail Messages`,
      value: truncateField(String(metrics.modmailReceived)),
      inline: true,
    },
    {
      name: `${label} — New Posts Submitted`,
      value: truncateField(String(metrics.newPostsSubmitted)),
      inline: true,
    },
    {
      name: `${label} — Mod Queue Items Flagged`,
      value: truncateField(String(metrics.modQueueFlagged)),
      inline: true,
    },
    {
      name: `${label} — Posts With Mod Response`,
      value: truncateField(String(metrics.postsWithModResponse)),
      inline: true,
    },
    {
      name: `${label} — Posts Without Mod Response`,
      value: truncateField(String(metrics.postsWithoutModResponse)),
      inline: true,
    },
    {
      name: `${label} — Avg Modmail Response Time`,
      value: truncateField(
        formatAverageDuration(
          metrics.modmailResponseTimeTotalMs,
          metrics.modmailResponseTimeSamples
        )
      ),
      inline: true,
    },
    {
      name: `${label} — Avg Post Response Time`,
      value: truncateField(
        formatAverageDuration(metrics.postResponseTimeTotalMs, metrics.postResponseTimeSamples)
      ),
      inline: true,
    },
    {
      name: `${label} — Modmail Resolved`,
      value: truncateField(String(metrics.modmailResolved)),
      inline: true,
    },
    {
      name: `${label} — Modmail Unresolved`,
      value: truncateField(String(metrics.modmailUnresolved)),
      inline: true,
    },
    {
      name: `${label} — Modmail Abandoned`,
      value: truncateField(String(metrics.modmailAbandoned)),
      inline: true,
    },
    {
      name: `${label} — Mod Queue Approved`,
      value: truncateField(String(metrics.modQueueApproved)),
      inline: true,
    },
    {
      name: `${label} — Mod Queue Removed`,
      value: truncateField(String(metrics.modQueueRemoved)),
      inline: true,
    },
    {
      name: `${label} — Posts Still Live`,
      value: truncateField(String(metrics.postsLive)),
      inline: true,
    },
    {
      name: `${label} — Posts Removed`,
      value: truncateField(String(metrics.postsRemoved)),
      inline: true,
    },
  ];
}

async function trackModMailForReport(event: ModMail, context: TriggerContext): Promise<void> {
  const subredditName =
    event.conversationSubreddit?.name ?? event.destinationSubreddit?.name ?? "";
  const subreddit = getMonitoredSubredditKey(subredditName);
  if (!subreddit) {
    return;
  }

  const conversationId = event.conversationId;
  if (!conversationId) {
    return;
  }

  const store = await getDailyReportStore(context);
  const metrics = getMetrics(store, subreddit);
  const participatingAs = event.messageAuthorType ?? "";
  const isModeratorMessage = participatingAs === "moderator";
  const isUserMessage = participatingAs === "participant_user";
  const now = Date.now();

  if (isUserMessage) {
    metrics.modmailReceived += 1;

    const existing = store.modmailConversations[conversationId];
    if (existing) {
      existing.lastUserMessageAt = now;
    } else {
      store.modmailConversations[conversationId] = {
        subreddit,
        firstUserMessageAt: now,
        lastUserMessageAt: now,
        lastModReplyAt: null,
        modReplied: false,
        resolved: false,
      };
    }
  }

  if (isModeratorMessage) {
    const conversation = store.modmailConversations[conversationId];
    if (conversation && !conversation.modReplied) {
      const responseMs = now - conversation.lastUserMessageAt;
      if (responseMs >= 0) {
        metrics.modmailResponseTimeTotalMs += responseMs;
        metrics.modmailResponseTimeSamples += 1;
      }
      conversation.modReplied = true;
      conversation.lastModReplyAt = now;
    } else if (conversation) {
      conversation.lastModReplyAt = now;
    }
  }

  const conversationState = (event.conversationState ?? "").toLowerCase();
  if (conversationState === "archived") {
    const conversation = store.modmailConversations[conversationId];
    if (conversation && !conversation.resolved) {
      conversation.resolved = true;
      metrics.modmailResolved += 1;
    }
  }

  await saveDailyReportStore(context, store);
}

async function trackModQueueForReport(
  event:
    | ({ type: "PostReport" } & PostReport)
    | ({ type: "CommentReport" } & CommentReport)
    | ({ type: "AutomoderatorFilterPost" } & AutomoderatorFilterPost)
    | ({ type: "AutomoderatorFilterComment" } & AutomoderatorFilterComment),
  context: TriggerContext
): Promise<void> {
  const subredditName = event.subreddit?.name ?? "";
  const subreddit = getMonitoredSubredditKey(subredditName);
  if (!subreddit) {
    return;
  }

  const store = await getDailyReportStore(context);
  getMetrics(store, subreddit).modQueueFlagged += 1;
  await saveDailyReportStore(context, store);
}

async function trackPostSubmitForReport(
  event: PostSubmit,
  context: TriggerContext
): Promise<void> {
  const subredditName = event.subreddit?.name ?? "";
  const post = event.post;
  const subreddit = getMonitoredSubredditKey(subredditName);

  if (!subreddit || !post) {
    return;
  }

  const store = await getDailyReportStore(context);
  const metrics = getMetrics(store, subreddit);
  const postId = toPostId(post.id);

  metrics.newPostsSubmitted += 1;
  metrics.postsWithoutModResponse += 1;

  let isLive = true;
  try {
    const livePost = await context.reddit.getPostById(postId);
    isLive = !livePost.removed;
  } catch (error) {
    console.error("Error checking post status for report tracking:", getErrorMessage(error));
  }

  if (isLive) {
    metrics.postsLive += 1;
  } else {
    metrics.postsRemoved += 1;
    metrics.postsWithoutModResponse -= 1;
  }

  store.trackedPosts[postId] = {
    subreddit,
    submittedAt: Date.now(),
    hasModResponse: false,
    isLive,
  };

  await saveDailyReportStore(context, store);
}

async function trackCommentSubmitForReport(
  event: CommentSubmit,
  context: TriggerContext
): Promise<void> {
  const subredditName = event.subreddit?.name ?? "";
  const subreddit = getMonitoredSubredditKey(subredditName);
  const postId = toPostId(event.comment?.postId ?? event.post?.id ?? "");
  const authorName = event.author?.name ?? event.comment?.author ?? "";

  if (!subreddit || !postId || !authorName) {
    return;
  }

  const author = await context.reddit.getUserByUsername(authorName);
  if (!author) {
    return;
  }

  const modPermissions = await author.getModPermissionsForSubreddit(
    normalizeSubredditName(subredditName)
  );
  if (modPermissions.length === 0) {
    return;
  }

  const store = await getDailyReportStore(context);
  const trackedPost = store.trackedPosts[postId];
  if (!trackedPost || trackedPost.hasModResponse) {
    return;
  }

  const metrics = getMetrics(store, trackedPost.subreddit);
  const responseMs = Date.now() - trackedPost.submittedAt;
  if (responseMs >= 0) {
    metrics.postResponseTimeTotalMs += responseMs;
    metrics.postResponseTimeSamples += 1;
  }

  trackedPost.hasModResponse = true;
  metrics.postsWithModResponse += 1;
  metrics.postsWithoutModResponse = Math.max(0, metrics.postsWithoutModResponse - 1);

  await saveDailyReportStore(context, store);
}

async function trackModActionForReport(event: ModAction, context: TriggerContext): Promise<void> {
  const subredditName = event.subreddit?.name ?? "";
  const subreddit = getMonitoredSubredditKey(subredditName);
  const action = (event.action ?? "").toLowerCase();

  if (!subreddit || !action) {
    return;
  }

  const store = await getDailyReportStore(context);
  const metrics = getMetrics(store, subreddit);

  if (MOD_QUEUE_APPROVE_ACTIONS.has(action)) {
    metrics.modQueueApproved += 1;
  }

  if (MOD_QUEUE_REMOVE_ACTIONS.has(action)) {
    metrics.modQueueRemoved += 1;
  }

  const postId = event.targetPost?.id ? toPostId(event.targetPost.id) : null;
  if (postId && store.trackedPosts[postId] && MOD_QUEUE_REMOVE_ACTIONS.has(action)) {
    const trackedPost = store.trackedPosts[postId];
    if (trackedPost.isLive) {
      trackedPost.isLive = false;
      metrics.postsLive = Math.max(0, metrics.postsLive - 1);
      metrics.postsRemoved += 1;
    }
  }

  await saveDailyReportStore(context, store);
}

async function getReportingWebhook(context: JobContext | TriggerContext): Promise<string | null> {
  const webhook = (await context.settings.get("reportingWebhook")) as string;
  if (!webhook) {
    console.error('No webhook URL configured for setting "reportingWebhook"');
    return null;
  }

  if (!isDiscordWebhook(webhook)) {
    console.error('Setting "reportingWebhook" is not a valid Discord webhook URL');
    return null;
  }

  return webhook;
}

async function ensureDailyReportScheduled(context: TriggerContext): Promise<void> {
  const existingJobId = await context.kvStore.get<string>(DAILY_REPORT_CRON_KV_KEY);
  if (existingJobId) {
    return;
  }

  const cronJobId = await context.scheduler.runJob({
    name: DAILY_REPORT_JOB_NAME,
    cron: "0 * * * *",
  });

  await context.kvStore.put(DAILY_REPORT_CRON_KV_KEY, cronJobId);
}

async function maybeSendDailyReport(context: JobContext): Promise<void> {
  const now = new Date();
  if (getLocalHour(now, REPORT_TIMEZONE) !== REPORT_HOUR) {
    return;
  }

  const todayKey = getDateKeyInTimezone(now, REPORT_TIMEZONE);
  const lastSentDate = await context.kvStore.get<string>(DAILY_REPORT_SENT_KV_KEY);
  if (lastSentDate === todayKey) {
    return;
  }

  await sendDailyReport(context);
  await context.kvStore.put(DAILY_REPORT_SENT_KV_KEY, todayKey);
  await resetDailyReportStore(context);
}

async function sendDailyReport(context: JobContext): Promise<void> {
  const webhook = await getReportingWebhook(context);
  if (!webhook) {
    return;
  }

  const store = await getDailyReportStore(context);
  finalizeModmailConversationMetrics(store);
  reconcilePostMetrics(store);

  const generatedAt = new Date();
  const footerText = truncateField(`Report generated ${formatReportGeneratedAt(generatedAt)}`);
  const periodField: DiscordEmbedField = {
    name: "Reporting Period",
    value: truncateField(formatReportingPeriod(store, generatedAt)),
  };

  const payload: DiscordWebhookPayload = {
    embeds: [
      {
        title: truncateTitle("Daily Moderation Report"),
        fields: [periodField, ...buildSubredditReportFields("spectrum", getMetrics(store, "spectrum"))],
        color: SPECTRUM_BLUE,
        footer: { text: footerText },
      },
      {
        title: truncateTitle("Daily Moderation Report — r/Spectrum_Official"),
        fields: buildSubredditReportFields(
          "spectrum_official",
          getMetrics(store, "spectrum_official")
        ),
        color: SPECTRUM_BLUE,
        footer: { text: footerText },
      },
    ],
  };

  await sendDiscordWebhook(webhook, payload);
}

async function getIgnoreList(context: TriggerContext): Promise<string[]> {
  const ignoreListRaw = (await context.settings.get("ignoreUsers")) as string;
  return (ignoreListRaw || "")
    .split(",")
    .map((username) => username.trim().toLowerCase())
    .filter(Boolean);
}

async function getWebhookUrl(
  context: TriggerContext,
  subredditName: string,
  category: WebhookCategory
): Promise<string | null> {
  const settingName = getWebhookSettingName(subredditName, category);
  if (!settingName) {
    console.log(`Subreddit "${subredditName}" is not monitored. Skipping webhook.`);
    return null;
  }

  const webhook = (await context.settings.get(settingName)) as string;
  if (!webhook) {
    console.error(`No webhook URL configured for setting "${settingName}"`);
    return null;
  }

  if (!isDiscordWebhook(webhook)) {
    console.error(`Setting "${settingName}" is not a valid Discord webhook URL`);
    return null;
  }

  return webhook;
}

async function sendDiscordWebhook(
  webhook: string,
  payload: DiscordWebhookPayload
): Promise<void> {
  const response = await fetch(webhook, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    console.error(`Error sending data to webhook: ${response.status} ${response.statusText}`);
  }
}

async function getNewAccountWarning(
  context: TriggerContext,
  username: string
): Promise<string | undefined> {
  try {
    const user = await context.reddit.getUserByUsername(username);
    if (!user) {
      return undefined;
    }

    const accountAgeMs = Date.now() - user.createdAt.getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const totalKarma = user.linkKarma + user.commentKarma;
    const warnings: string[] = [];

    if (accountAgeMs < sevenDaysMs) {
      warnings.push("account is less than 7 days old");
    }

    if (totalKarma < 1) {
      warnings.push("account has less than 1 karma");
    }

    if (warnings.length === 0) {
      return undefined;
    }

    return `⚠️ Warning: ${warnings.join(" and ")}`;
  } catch (error) {
    console.error("Error checking account age/karma:", getErrorMessage(error));
    return undefined;
  }
}

async function sendModMailToWebhook(event: ModMail, context: TriggerContext) {
  const subredditName =
    event.conversationSubreddit?.name ??
    event.destinationSubreddit?.name ??
    "";

  if (!subredditName || !isMonitoredSubreddit(subredditName)) {
    console.log(`Skipping modmail for unmonitored subreddit "${subredditName || "unknown"}".`);
    return;
  }

  const webhook = await getWebhookUrl(context, subredditName, "modmail");
  if (!webhook) {
    return;
  }

  const outgoing = (await context.settings.get("outgoing")) as boolean;
  const rolePing = (await context.settings.get("rolePing")) as string | undefined;
  const onlyModDiscussions = (await context.settings.get("onlyModDiscussions")) as boolean;
  const ignoreList = await getIgnoreList(context);

  const conversationId = event.conversationId ?? "";
  const actualConversationId = conversationId.replace("ModmailConversation_", "");
  const result = await context.reddit.modMail.getConversation({
    conversationId,
    markRead: false,
  });

  const isModDiscussion = result.conversation?.isInternal ?? false;
  if (onlyModDiscussions && !isModDiscussion) {
    console.log("Skipping regular modmail because only mod discussions are enabled.");
    return;
  }

  const modmailLink = `https://reddit.com/mail/all/${actualConversationId}`;
  const messages = result.conversation?.messages ?? {};
  const message: MessageData | undefined =
    (event.messageId ? messages[event.messageId] : undefined) ??
    (() => {
      const messageIds = Object.keys(messages);
      const lastMessageId =
        messageIds.length > 0 ? messageIds[messageIds.length - 1] : undefined;
      return lastMessageId ? messages[lastMessageId] : undefined;
    })();

  if (!message) {
    console.error("No messages found");
    return;
  }

  const authorName =
    message.author?.name ?? event.messageAuthor?.name ?? "Unknown";
  const body = message.bodyMarkdown ?? message.body ?? "";
  const participatingAs =
    message.participatingAs ?? event.messageAuthorType ?? "Unknown";
  const participantName = result.conversation?.participant?.name ?? "N/A";
  const isPrivateNote = message.isInternal ?? false;

  if (ignoreList.includes(authorName.toLowerCase())) {
    console.log(`User "${authorName}" is in the ignore list. Skipping webhook.`);
    return;
  }

  if (participatingAs === "moderator" && !outgoing) {
    console.log("Not sending outgoing messages to the webhook");
    return;
  }

  const displaySubreddit = normalizeSubredditName(subredditName);
  const payload: DiscordWebhookPayload = {
    content: rolePing ? `<@&${rolePing}>` : undefined,
    embeds: [
      {
        title: truncateTitle(result.conversation?.subject ?? "Modmail"),
        url: modmailLink,
        author: {
          name: authorName,
          url: redditProfileUrl(authorName),
        },
        fields: [
          {
            name: "Subreddit",
            value: truncateField(`r/${displaySubreddit}`),
            inline: true,
          },
          {
            name: "Participating As",
            value: truncateField(participatingAs),
            inline: true,
          },
          {
            name: "Participant",
            value: truncateField(participantName),
            inline: true,
          },
          {
            name: "Message Preview",
            value: truncateField(previewText(body)),
          },
        ],
        color: isPrivateNote ? PRIVATE_NOTE_GREEN : SPECTRUM_BLUE,
        timestamp: new Date().toISOString(),
      },
    ],
  };

  await sendDiscordWebhook(webhook, payload);
}

async function sendModQueueEmbed(
  context: TriggerContext,
  subredditName: string,
  options: {
    title: string;
    url: string;
    username: string;
    contentType: "post" | "comment";
    reason: string;
    contentPreview: string;
    isAutomod: boolean;
  }
): Promise<void> {
  if (!isMonitoredSubreddit(subredditName)) {
    console.log(`Skipping mod queue alert for unmonitored subreddit "${subredditName}".`);
    return;
  }

  const webhook = await getWebhookUrl(context, subredditName, "modqueue");
  if (!webhook) {
    return;
  }

  const warning = await getNewAccountWarning(context, options.username);
  const displaySubreddit = normalizeSubredditName(subredditName);
  const fields: DiscordEmbedField[] = [
    {
      name: "Subreddit",
      value: truncateField(`r/${displaySubreddit}`),
      inline: true,
    },
    {
      name: "Content Type",
      value: truncateField(options.contentType),
      inline: true,
    },
    {
      name: "Reason",
      value: truncateField(options.reason || "Unknown"),
      inline: true,
    },
    {
      name: "Content Preview",
      value: truncateField(previewText(options.contentPreview)),
    },
  ];

  if (warning) {
    fields.push({
      name: "Account Warning",
      value: truncateField(warning),
    });
  }

  const payload: DiscordWebhookPayload = {
    embeds: [
      {
        title: truncateTitle(options.title),
        url: options.url,
        author: {
          name: options.username,
          url: redditProfileUrl(options.username),
        },
        fields,
        color: options.isAutomod ? AUTOMOD_YELLOW : REPORTED_ORANGE,
        timestamp: new Date().toISOString(),
      },
    ],
  };

  await sendDiscordWebhook(webhook, payload);
}

async function sendModQueueAlertFromPostReport(
  event: PostReport,
  context: TriggerContext
) {
  const subredditName = event.subreddit?.name ?? "";
  const post = event.post;

  if (!subredditName || !post) {
    console.error("PostReport event is missing subreddit or post data");
    return;
  }

  const redditPost = await context.reddit.getPostById(toPostId(post.id));
  const username = redditPost.authorName ?? "Unknown";
  const contentPreview = post.selftext || post.title || "";
  const title = post.title || previewText(contentPreview, 100);

  await sendModQueueEmbed(context, subredditName, {
    title,
    url: redditPermalinkUrl(post.permalink),
    username,
    contentType: "post",
    reason: event.reason,
    contentPreview,
    isAutomod: false,
  });
}

async function sendModQueueAlertFromCommentReport(
  event: CommentReport,
  context: TriggerContext
) {
  const subredditName = event.subreddit?.name ?? "";
  const comment = event.comment;

  if (!subredditName || !comment) {
    console.error("CommentReport event is missing subreddit or comment data");
    return;
  }

  const contentPreview = comment.body ?? "";
  const title = previewText(contentPreview, 100) || "Reported Comment";

  await sendModQueueEmbed(context, subredditName, {
    title,
    url: redditPermalinkUrl(comment.permalink),
    username: comment.author || "Unknown",
    contentType: "comment",
    reason: event.reason,
    contentPreview,
    isAutomod: false,
  });
}

async function sendModQueueAlertFromAutomodPost(
  event: AutomoderatorFilterPost,
  context: TriggerContext
) {
  const subredditName = event.subreddit?.name ?? "";
  const post = event.post;

  if (!subredditName || !post) {
    console.error("AutomoderatorFilterPost event is missing subreddit or post data");
    return;
  }

  const username = event.author || "Unknown";
  const contentPreview = post.selftext || post.title || "";
  const title = post.title || previewText(contentPreview, 100);

  await sendModQueueEmbed(context, subredditName, {
    title,
    url: redditPermalinkUrl(post.permalink),
    username,
    contentType: "post",
    reason: event.reason,
    contentPreview,
    isAutomod: true,
  });
}

async function sendModQueueAlertFromAutomodComment(
  event: AutomoderatorFilterComment,
  context: TriggerContext
) {
  const subredditName = event.subreddit?.name ?? "";
  const comment = event.comment;

  if (!subredditName || !comment) {
    console.error("AutomoderatorFilterComment event is missing subreddit or comment data");
    return;
  }

  const contentPreview = comment.body ?? "";
  const title = previewText(contentPreview, 100) || "AutoMod Filtered Comment";

  await sendModQueueEmbed(context, subredditName, {
    title,
    url: redditPermalinkUrl(comment.permalink),
    username: event.author || comment.author || "Unknown",
    contentType: "comment",
    reason: event.reason,
    contentPreview,
    isAutomod: true,
  });
}

async function sendNewPostAlert(event: PostSubmit, context: TriggerContext) {
  const subredditName = event.subreddit?.name ?? "";
  const post = event.post;
  const author = event.author;

  if (!subredditName || !post) {
    console.error("PostSubmit event is missing subreddit or post data");
    return;
  }

  if (!isMonitoredSubreddit(subredditName)) {
    console.log(`Skipping new post alert for unmonitored subreddit "${subredditName}".`);
    return;
  }

  await sleep(10_000);

  const livePost = await context.reddit.getPostById(toPostId(post.id));
  if (livePost.removed) {
    console.log(`Post ${post.id} was removed before alert could be sent. Skipping.`);
    return;
  }

  const webhook = await getWebhookUrl(context, subredditName, "newposts");
  if (!webhook) {
    return;
  }

  const username = author?.name ?? livePost.authorName ?? "Unknown";
  const postUrl = redditPermalinkUrl(post.permalink);
  const flairText = post.linkFlair?.text?.trim();
  const bodyPreview = post.isSelf ? previewText(post.selftext ?? "") : "";
  const displaySubreddit = normalizeSubredditName(subredditName);

  const fields: DiscordEmbedField[] = [
    {
      name: "Subreddit",
      value: truncateField(`r/${displaySubreddit}`),
      inline: true,
    },
  ];

  if (flairText) {
    fields.push({
      name: "Post Flair",
      value: truncateField(flairText),
      inline: true,
    });
  }

  if (bodyPreview) {
    fields.push({
      name: "Post Preview",
      value: truncateField(bodyPreview),
    });
  }

  const payload: DiscordWebhookPayload = {
    embeds: [
      {
        title: truncateTitle(post.title),
        url: postUrl,
        author: {
          name: username,
          url: redditProfileUrl(username),
        },
        fields,
        color: flairText ? SPECTRUM_BLUE : POST_WHITE,
        timestamp: new Date().toISOString(),
      },
    ],
  };

  await sendDiscordWebhook(webhook, payload);
}

export default Devvit;
