import {
  AutomoderatorFilterComment,
  AutomoderatorFilterPost,
  CommentReport,
  MessageData,
  ModMail,
  PostReport,
  PostSubmit,
} from "@devvit/protos";
import { Devvit, TriggerContext } from "@devvit/public-api";

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

type WebhookCategory = "modmail" | "modqueue" | "newposts";

type DiscordEmbedField = {
  name: string;
  value: string;
  inline?: boolean;
};

type DiscordEmbed = {
  title?: string;
  url?: string;
  author?: {
    name: string;
    url?: string;
  };
  fields?: DiscordEmbedField[];
  color?: number;
  timestamp?: string;
};

type DiscordWebhookPayload = {
  content?: string;
  embeds: DiscordEmbed[];
};

Devvit.configure({
  http: true,
  redditAPI: true,
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
      await sendNewPostAlert(event, context);
    } catch (error) {
      console.error(
        "PostSubmit trigger error:",
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

function toCommentId(id: string): string {
  return id.startsWith("t1_") ? id : `t1_${id}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
