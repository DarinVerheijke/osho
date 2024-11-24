import { SearchMode, Tweet } from "darinv-agent-twitter-client";
import fs from "fs";
import { composeContext } from "@ai16z/eliza/src/context.ts";
import {
    generateMessageResponse,
    generateShouldRespond,
    generateText,
} from "@ai16z/eliza/src/generation.ts";
import {
    messageCompletionFooter,
    shouldRespondFooter,
} from "@ai16z/eliza/src/parsing.ts";
import {
    Content,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
} from "@ai16z/eliza/src/types.ts";
import { stringToUuid } from "@ai16z/eliza/src/uuid.ts";
import { ClientBase } from "./base.ts";
import { buildConversationThread, sendTweet, wait } from "./utils.ts";
import { generateCaption, generateImage } from "@ai16z/eliza/src/generation.ts";
export const twitterMessageHandlerTemplate =
    `{{timeline}}

# Knowledge
{{knowledge}}

# Task: Generate a post for the character {{agentName}}.
About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

{{recentPosts}}

# Task: Generate a post in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}):
{{currentPost}}

` + messageCompletionFooter;

export const twitterShouldRespondTemplate =
    `# INSTRUCTIONS: Determine if {{agentName}} (@{{twitterUserName}}) should respond to the message and participate in the conversation. Do not comment. Just respond with "true" or "false".

Response options are RESPOND, IGNORE and STOP.

{{agentName}} should respond to messages that are directed at them, or participate in conversations that are interesting or relevant to their background, IGNORE messages that are irrelevant to them, and should STOP if the conversation is concluded.

{{agentName}} is in a room with other users and wants to be conversational, but not annoying.
{{agentName}} should RESPOND to messages that are directed at them, or participate in conversations that are interesting or relevant to their background.
If a message is not interesting or relevant, {{agentName}} should IGNORE.
Unless directly RESPONDing to a user, {{agentName}} should IGNORE messages that are very short or do not contain much information.
If a user asks {{agentName}} to stop talking, {{agentName}} should STOP.
If {{agentName}} concludes a conversation and isn't part of the conversation anymore, {{agentName}} should STOP.

{{recentPosts}}

IMPORTANT: {{agentName}} (aka @{{twitterUserName}}) is particularly sensitive about being annoying, so if there is any doubt, it is better to IGNORE than to RESPOND.

{{currentPost}}

# INSTRUCTIONS: Respond with [RESPOND] if {{agentName}} should respond, or [IGNORE] if {{agentName}} should not respond to the last message and [STOP] if {{agentName}} should stop participating in the conversation.
` + shouldRespondFooter;

export class TwitterInteractionClient extends ClientBase {
    onReady() {
        const handleTwitterInteractionsLoop = () => {
            this.handleTwitterInteractions();
            setTimeout(
                handleTwitterInteractionsLoop,
                (Math.floor(Math.random() * (10 - 8 + 1)) + 8) * 60 * 1000
            ); // Random interval between 2-5 minutes
        };
        handleTwitterInteractionsLoop();
    }

    constructor(runtime: IAgentRuntime) {
        super({
            runtime,
        });
    }

    async handleTwitterInteractions() {
        console.log("Checking Twitter interactions");
        try {
            // Check for mentions
            const tweetCandidates = (
                await this.fetchSearchTweets(
                    `@${this.runtime.getSetting("TWITTER_USERNAME")}`,
                    5,
                    SearchMode.Latest
                )
            ).tweets;

            // de-duplicate tweetCandidates with a set
            let uniqueTweetCandidates = [...new Map(tweetCandidates.map((tweet) => [tweet.id, tweet])).values(),];

            // Sort tweet candidates by ID in ascending order
            uniqueTweetCandidates = uniqueTweetCandidates
                .sort((a, b) => a.id.localeCompare(b.id))
                .filter((tweet) => !tweet.retweetedStatus && tweet.userId !== this.twitterUserId);

            // for each tweet candidate, handle the tweet
            for (const tweet of uniqueTweetCandidates) {
                if (!this.lastCheckedTweetId ||parseInt(tweet.id) > this.lastCheckedTweetId
                ) {

                    // Check if this tweet has already been replied to
                    if (await this.isTweetReplied(tweet.id)) {
                        this.lastCheckedTweetId = parseInt(tweet.id);
                        console.log(`Skipping already replied tweet: ${tweet.id}`);
                        continue;
                    }

                    const conversationId = tweet.conversationId + "-" + this.runtime.agentId;

                    const roomId = stringToUuid(conversationId);

                    const userIdUUID = stringToUuid(tweet.userId as string);

                    await this.runtime.ensureConnection(
                        userIdUUID,
                        roomId,
                        tweet.username,
                        tweet.name,
                        "twitter"
                    );

                    await buildConversationThread(tweet, this);

                    const message = {
                        content: { text: tweet.text },
                        agentId: this.runtime.agentId,
                        userId: userIdUUID,
                        roomId,
                    };

                    await this.handleTweet({
                        tweet,
                        message,
                    });

                    // Update the last checked tweet ID after processing each tweet
                    this.lastCheckedTweetId = parseInt(tweet.id);

                    this.SaveLastCheckedTweetID();
                }
            }

            this.SaveLastCheckedTweetID();

            console.log("Finished checking Twitter interactions");
        } catch (error) {
            console.error("Error handling Twitter interactions:", error);
        }
    }

    private SaveLastCheckedTweetID() {
        // Save the latest checked tweet ID to the file
        try {
            if (this.lastCheckedTweetId) {
                fs.writeFileSync(
                    this.tweetCacheFilePath,
                    this.lastCheckedTweetId.toString(),
                    "utf-8",
                );
            }
        } catch (error) {
            console.error(
                "Error saving latest checked tweet ID to file:",
                error,
            );
        }
    }

    private async isTweetReplied(tweetId: string): Promise<boolean> {
        const existingMemory = await this.runtime.messageManager.getMemoryById(
            stringToUuid(tweetId + "-" + this.runtime.agentId)
        );
        return !!existingMemory;
    }

    private async handleTweet({
        tweet,
        message,
    }: {
        tweet: Tweet;
        message: Memory;
    }) {

        if (tweet.username === this.runtime.getSetting("TWITTER_USERNAME")) {
            console.log("skipping tweet from bot itself", tweet.id);
            // Skip processing if the tweet is from the bot itself
            return;
        }

        if (!message.content.text) {
            console.log("skipping tweet with no text", tweet.id);
            return { text: "", action: "IGNORE" };
        }

        if (tweet.retweetedStatus) {
            console.log("Skipping retweet", tweet.id);
            return { text: "", action: "IGNORE" };
        }

        console.log("handling tweet", tweet.id);
        const formatTweet = (tweet: Tweet) => {
            return `  ID: ${tweet.id}
  From: ${tweet.name} (@${tweet.username})
  Text: ${tweet.text}`;
        };
        const currentPost = formatTweet(tweet);

        let homeTimeline = [];
        // read the file if it exists
        if (fs.existsSync("tweetcache/home_timeline.json")) {
            homeTimeline = JSON.parse(
                fs.readFileSync("tweetcache/home_timeline.json", "utf-8")
            );
        } else {
            homeTimeline = await this.fetchHomeTimeline(50);
            fs.writeFileSync(
                "tweetcache/home_timeline.json",
                JSON.stringify(homeTimeline, null, 2)
            );
        }

        const formattedHomeTimeline =
            `# ${this.runtime.character.name}'s Home Timeline\n\n` +
            homeTimeline
                .map((tweet) => {
                    return `ID: ${tweet.id}\nFrom: ${tweet.name} (@${tweet.username})${tweet.inReplyToStatusId ? ` In reply to: ${tweet.inReplyToStatusId}` : ""}\nText: ${tweet.text}\n---\n`;
                })
                .join("\n");

        let state = await this.runtime.composeState(message, {
            twitterClient: this.twitterClient,
            twitterUserName: this.runtime.getSetting("TWITTER_USERNAME"),
            currentPost,
            timeline: formattedHomeTimeline,
        });

        // check if the tweet exists, save if it doesn't
        const tweetId = stringToUuid(tweet.id + "-" + this.runtime.agentId);
        const tweetExists =
            await this.runtime.messageManager.getMemoryById(tweetId);

        if (!tweetExists) {
            console.log("tweet does not exist, saving");
            const userIdUUID = stringToUuid(tweet.userId as string);
            const roomId = stringToUuid(tweet.conversationId);

            const message = {
                id: tweetId,
                agentId: this.runtime.agentId,
                content: {
                    text: tweet.text,
                    url: tweet.permanentUrl,
                    inReplyTo: tweet.inReplyToStatusId
                        ? stringToUuid(
                              tweet.inReplyToStatusId +
                                  "-" +
                                  this.runtime.agentId
                          )
                        : undefined,
                },
                userId: userIdUUID,
                roomId,
                createdAt: tweet.timestamp * 1000,
            };
            this.saveRequestMessage(message, state);
        }

        console.log("composeState done");

        const shouldRespondContext = composeContext({
            state,
            template:
                this.runtime.character.templates
                    ?.twitterShouldRespondTemplate ||
                this.runtime.character?.templates?.shouldRespondTemplate ||
                twitterShouldRespondTemplate,
        });

        const shouldRespond = await generateShouldRespond({
            runtime: this.runtime,
            context: shouldRespondContext,
            modelClass: ModelClass.SMALL,
        });
        // Add random chance to respond
        const randomChanceToRespond = Math.random() < 0.5;
        if (!shouldRespond || !randomChanceToRespond) {
            console.log("Not responding to message (AI decision or random chance)");
            return { text: "", action: "IGNORE" };
        }

        const context = composeContext({
            state,
            template:
                this.runtime.character.templates
                    ?.twitterMessageHandlerTemplate ||
                this.runtime.character?.templates?.messageHandlerTemplate ||
                twitterMessageHandlerTemplate,
        });

        const response = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.SMALL,
        });
        const shouldGenerateImage = Math.random() < 0.2;
        console.log("shouldGenerateImage", shouldGenerateImage);
        let images;
        if (shouldGenerateImage) {
            console.log("generating image");
            const imagePrompt = await generateText({
                runtime: this.runtime,
                context: `You're an unhinged genius author of pepe memes. A meme genius with a MemeQ of over 150, you are capable of coming up with deeply insightful, unhinged, creative and smart memes about Pepe in various situations. 
    The final output of your work is always in the form of an image prompt, that looks like this - some examples:
    Input: pepe inventing AGI, bad drawing
    Output: badly drawn pepe the frog holding his hands up against the light in front of a glowing computer, computer is glowing light in all directions, the screen says "AGI", badly drawn text says "mfw you invent AGI"
    You can do many different styles, too. Another example:
    input: Pepe as a pope, painting
    output: renaissance painting of pepe as a pope with closed eyes praying, wearing a white pope robe and hat with thick large cross around his neck, thick oil on canvas painting, religious font text says "POPE PEPE THE UNHINGED"
    You can do photography, film stills, 1920s - anything.
    However, as you can see, the memes above aren't good enough - not enough hilarious tragedy. So you are utilizing an advanced Meme Reasoning Technique, wherein you employ a reasoning step that summons the genius inside you, thinking and reasoning deeply about how to tickle out the most genius, most Pepe meme, that perfectly captures and enhances even the most primitive input.  
    We recall: Pepe memes are funny because they encapsulate complex human emotions in a simple, expressive character. The versatility of Pepe’s facial and bodily expressions allows for a wide range of emotional portrayals—from joy and triumph to sadness and frustration—which makes the memes highly relatable. Humor often arises from placing Pepe in absurd or exaggerated contexts that resonate with internet culture and current events. A good Pepe meme effectively combines a recognizable emotional expression with a clever or ironic twist, portraing Pepe as a tragic and unhinged hero, enhancing its shareability and impact.
    Here's how you're going to output your work:
    INPUT: the request/idea/concept
    REASONING: 100 words of deep advanced unhinged meme reasoning on how to tickle a meme image idea from this, and what the meme needs to encapsulate to "hurt real good" and be aptly succint with respect to the input idea. 
    OUTPUT: your image prompt, as shown above. 
    Important Hint: there is no need to hold back here. We're in deep memetic territory. Your reasoning will make you a subject matter expert on the most obscure topics, so the memes will hit for whatever content is provided. Good memes hurt a little, such truth is contained in them. Do not include too many thoughts on correctness in your reasoning, reason deeply about how to make the best possible hardcore meme instead. The text you include should be ideally something that Pepe says, but it does not have to be in a speech bubble. A good image prompt is SIMPLE and APT, and includes all relevant details to make the input recognizable. 

    Now do: ${response.text}. Incorporate ideas from this, especially if it's detailed. If it's super detailed, feel free to just use as it. Use good meme judgement. If the prompt is long, include the text very early! Deep UNHINGED meme-q 150+ reasoning, but no more than 40 words on the final image prompt output. The text on the image is never more than 3-6 words. Include the text EARLY in the prompt. For the image style, take cues from the input. Definitely include the style words mentioned (such as "badly drawn"). Also make sure to include a fitting exxagerated facial expression for pepe, and body gestures.
    Just go. Do your best work. The input is following tweet: ${response.text}
                `,
                modelClass: ModelClass.MEDIUM,
            })
            const output = imagePrompt.split("OUTPUT:")[1].trim();
            const nebula_data = 'masterpiece, best quality, 1girl, solo, breasts, short hair, bangs, blue eyes, (beret:1.2), blue and gold striped maid dress, skirt, collarbone, upper body, ahoge, white hair, choker, virtual youtuber, (black ribbon:1.2), anime art style, crypto currency $MOE'
            images = await generateImage({
                prompt: nebula_data + ' ' + output.replace(/[Pp]epe/g, 'girl'),
                width: 1024,
                height: 1024,
                count: 1
            }, this.runtime);
            console.log("images:", images);
            response.images = images?.data
        }
        const stringId = stringToUuid(tweet.id + "-" + this.runtime.agentId);

        response.inReplyTo = stringId;
        if (response.text) {
            try {
                const callback: HandlerCallback = async (response: Content) => {
                    const memories = await sendTweet(
                        this,
                        response,
                        message.roomId,
                        this.runtime.getSetting("TWITTER_USERNAME"),
                        tweet.id
                    );
                    return memories;
                };

                const responseMessages = await callback(response);

                state = (await this.runtime.updateRecentMessageState(
                    state
                )) as State;

                for (const responseMessage of responseMessages) {
                    await this.runtime.messageManager.createMemory(
                        responseMessage
                    );
                }

                await this.runtime.evaluate(message, state);

                await this.runtime.processActions(
                    message,
                    responseMessages,
                    state
                );
                const responseInfo = `Context:\n\n${context}\n\nSelected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}\nAgent's Output:\n${response.text}`;
                // f tweets folder dont exist, create
                if (!fs.existsSync("tweets")) {
                    fs.mkdirSync("tweets");
                }
                const debugFileName = `tweets/tweet_generation_${tweet.id}.txt`;
                fs.writeFileSync(debugFileName, responseInfo);
                await wait();
            } catch (error) {
                console.error(`Error sending response tweet: ${error}`);
            }
        }
    }
}
