const config = require("./config");

const QUERY_IDS = {
  following: { id: "DiTkXJgLqBBxCs7zaYsbtA", operation: "HomeLatestTimeline" },
  for_you: { id: "HJFjzBgCs16TqxewQOeLNg", operation: "HomeTimeline" },
};

function normalizeFastTweets(tweets) {
  return (tweets || [])
    .filter((tweet) => tweet && tweet.id && tweet.text)
    .map((tweet) => {
      const handle = tweet.author ? `@${tweet.author}` : "";
      const user = tweet.name && tweet.author ? `${tweet.name} ${handle}` : handle || tweet.name || "";
      return {
        user,
        time: new Date(tweet.created_at).toISOString(),
        type: tweet.type || "tweet",
        text: tweet.text,
        hasMedia: false,
        link: tweet.url || (tweet.author ? `https://x.com/${tweet.author}/status/${tweet.id}` : ""),
        // following 来自 X API 的 user.legacy.following
        isFollowed: tweet.following === true ? true : tweet.following === false ? false : null,
      };
    })
    .sort((a, b) => b.time.localeCompare(a.time));
}

async function collectFastTimeline(page, options = {}) {
  const source = options.source || "following";
  const adapter = QUERY_IDS[source];
  if (!adapter) throw new Error(`Unsupported fast X source: ${source}`);

  const count = Math.min(
    Number.parseInt(options.count || config.xFast?.count || 40, 10),
    config.xFast?.maxCount || 50,
  );

  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(options.initialWaitMs || 1500);

  const result = await page.evaluate(async ({ adapter, count }) => {
    const ct0 = document.cookie.split(";").map((c) => c.trim()).find((c) => c.startsWith("ct0="))?.split("=")[1];
    if (!ct0) return { error: "No ct0 cookie", hint: "Please log in to https://x.com first." };

    const bearer = decodeURIComponent("AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA");
    const headers = {
      Authorization: `Bearer ${bearer}`,
      "X-Csrf-Token": ct0,
      "X-Twitter-Auth-Type": "OAuth2Session",
      "X-Twitter-Active-User": "yes",
    };
    const variables = JSON.stringify({
      count,
      includePromotedContent: false,
      latestControlAvailable: true,
      requestContext: "launch",
      withCommunity: true,
    });
    const features = JSON.stringify({
      rweb_video_screen_enabled: false,
      profile_label_improvements_pcf_label_in_post_enabled: true,
      responsive_web_profile_redirect_enabled: false,
      rweb_tipjar_consumption_enabled: false,
      verified_phone_label_enabled: false,
      creator_subscriptions_tweet_preview_api_enabled: true,
      responsive_web_graphql_timeline_navigation_enabled: true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      premium_content_api_read_enabled: false,
      communities_web_enable_tweet_community_results_fetch: true,
      c9s_tweet_anatomy_moderator_badge_enabled: true,
      articles_preview_enabled: true,
      responsive_web_edit_tweet_api_enabled: true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
      view_counts_everywhere_api_enabled: true,
      longform_notetweets_consumption_enabled: true,
      responsive_web_twitter_article_tweet_consumption_enabled: true,
      tweet_awards_web_tipping_enabled: false,
      content_disclosure_indicator_enabled: true,
      content_disclosure_ai_generated_indicator_enabled: true,
      freedom_of_speech_not_reach_fetch_enabled: true,
      standardized_nudges_misinfo: true,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
      longform_notetweets_rich_text_read_enabled: true,
      longform_notetweets_inline_media_enabled: false,
      responsive_web_enhance_cards_enabled: false,
    });

    const url = `/i/api/graphql/${adapter.id}/${adapter.operation}?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(features)}`;
    const resp = await fetch(url, { headers, credentials: "include" });
    if (!resp.ok) return { error: `HTTP ${resp.status}`, hint: "X GraphQL queryId may have changed." };
    const data = await resp.json();
    const instructions = data.data?.home?.home_timeline_urt?.instructions || [];
    const tweets = [];

    function extractTweet(itemContent, sourceText) {
      if (!itemContent || itemContent.promotedMetadata) return;
      const result = itemContent.tweet_results?.result;
      if (!result) return;
      const tw = result.tweet || result;
      const legacy = tw.legacy || {};
      if (!tw.rest_id) return;
      const user = tw.core?.user_results?.result;
      const noteText = tw.note_tweet?.note_tweet_results?.result?.text;
      const screenName = user?.legacy?.screen_name || user?.core?.screen_name;
      const retweet = legacy.retweeted_status_result?.result;
      if (retweet) {
        const rtw = retweet.tweet || retweet;
        const rLegacy = rtw.legacy || {};
        const rUser = rtw.core?.user_results?.result;
        const rNoteText = rtw.note_tweet?.note_tweet_results?.result?.text;
        tweets.push({
          id: tw.rest_id,
          type: "retweet",
          author: screenName,
          rt_author: rUser?.legacy?.screen_name || rUser?.core?.screen_name,
          url: `https://x.com/${screenName || "_"}/status/${tw.rest_id}`,
          text: rNoteText || rLegacy.full_text || "",
          likes: rLegacy.favorite_count,
          retweets: rLegacy.retweet_count,
          created_at: legacy.created_at,
          source: sourceText || undefined,
          following: user?.legacy?.following,
        });
        return;
      }
      tweets.push({
        id: tw.rest_id,
        type: legacy.in_reply_to_status_id_str ? "reply" : "tweet",
        author: screenName,
        name: user?.legacy?.name || user?.core?.name,
        url: `https://x.com/${screenName || "_"}/status/${tw.rest_id}`,
        text: noteText || legacy.full_text || "",
        likes: legacy.favorite_count,
        retweets: legacy.retweet_count,
        created_at: legacy.created_at,
        source: sourceText || itemContent.socialContext?.text || undefined,
        following: user?.legacy?.following,
      });
    }

    for (const instruction of instructions) {
      for (const entry of instruction.entries || []) {
        const content = entry.content;
        if (content?.items) {
          for (const item of content.items) extractTweet(item.item?.itemContent, null);
          continue;
        }
        extractTweet(content?.itemContent, null);
      }
    }
    return { count: tweets.length, tweets };
  }, { adapter, count });

  if (result?.error) {
    throw new Error(`${result.error}${result.hint ? `: ${result.hint}` : ""}`);
  }

  const tweets = normalizeFastTweets(result.tweets);
  if (tweets.length === 0) throw new Error("Fast X adapter returned no tweets.");
  return {
    tweets,
    reachedTarget: false,
    newestTime: tweets[0]?.time || null,
    oldestTime: tweets[tweets.length - 1]?.time || null,
    fast: true,
  };
}

module.exports = {
  collectFastTimeline,
  normalizeFastTweets,
};
