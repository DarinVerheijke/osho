import { IAgentRuntime, Content, HandlerCallback, State, ModelClass, ServiceType, IImageDescriptionService } from "@ai16z/eliza/src/types.ts";
import { stringToUuid } from "@ai16z/eliza/src/uuid.ts";
import fs from "fs";
import { composeContext } from "@ai16z/eliza/src/context.ts";
import { wait, sendTweet, buildConversationThread } from "./utils.ts"; // Adjust the import path as necessary
import { generateMessageResponse, generateText } from "@ai16z/eliza/src/generation.ts";
import { ClientBase } from "./base.ts";
import { messageCompletionFooter } from "@ai16z/eliza/src/parsing.ts";

const twitterSearchTemplate =
    `{{timeline}}

    {{providers}}

    Recent interactions between {{agentName}} and other users:
    {{recentPostInteractions}}

    About {{agentName}} (@{{twitterUserName}}):
    {{bio}}
    {{lore}}
    {{topics}}

    {{postDirections}}

    {{recentPosts}}

    # Task: Respond to the following post in the style and perspective of {{agentName}} (aka @{{twitterUserName}}). Write a {{adjective}} response for {{agentName}} to say directly in response to the post. don't generalize.
    {{currentPost}}

    IMPORTANT: Your response CANNOT be longer than 20 words.
    Your response CANNOT be longer than 250 characters.
    Aim for 1-2 short sentences maximum. Be concise and direct.

    Your response should not contain any questions. Brief, concise statements only. No emojis. Use \\n\\n (double spaces) between statements.

    ` + messageCompletionFooter;

export class TwitterInteractPeopleClient extends ClientBase {
    private respondedTweets: Set<string> = new Set();
    private checkInterval: NodeJS.Timeout | null = null;
    private usernames: string[];

    constructor(runtime: IAgentRuntime) {
        super({ runtime });
        this.usernames = this.loadUsernames();
    }

    private loadUsernames(): string[] {
        // Check if character's people array exists and is not empty
        if (!this.runtime.character.people || this.runtime.character.people.length === 0) {
            console.warn("No usernames found in character's people array.");
            return []; // Return an empty array if no usernames are available
        }
        // Load usernames from the character's people array
        return [...this.runtime.character.people];
    }

    async onReady() {
        if (!this.checkInterval && this.usernames.length > 0) {
            this.checkForNewTweetsLoop();
        }
    }

    private checkForNewTweetsLoop() {
        this.checkForNewTweets().then(() => {
            // Set a random interval between 5 to 10 minutes
            const randomInterval = Math.floor(Math.random() * (10 - 5 + 1) + 5) * 60 * 1000;
            this.checkInterval = setTimeout(() => this.checkForNewTweetsLoop(), randomInterval);
        }).catch(error => {
            console.error("Error in checkForNewTweetsLoop:", error);
        });
    }

    private async checkForNewTweets() {
        if (!fs.existsSync("tweetcache")) {
            fs.mkdirSync("tweetcache"); // Create tweetcache directory if it doesn't exist
        }

        for (const username of this.usernames) {
            try {
                await new Promise((resolve) => setTimeout(resolve, 10000)); // Rate limiting
                const recentTweets = await this.fetchUserTweets(username);

                console.log(recentTweets, "recentTweets----------");
                
                const formattedHomeTimeline =
                    `# ${this.runtime.character.name}'s Home Timeline\n\n` +
                    recentTweets
                        .map((tweet) => {
                            return `ID: ${tweet.id}\nFrom: ${tweet.name} (@${tweet.username})${tweet.inReplyToStatusId ? ` In reply to: ${tweet.inReplyToStatusId}` : ""}\nText: ${tweet.text}\n---\n`;
                        })
                        .join("\n");
                if (recentTweets.length === 0) {
                    console.log(`No tweets found for user: ${username}`);
                    continue; // Skip to the next user if no tweets are found
                }
                for (const tweet of recentTweets) {

                    let hasAlreadyResponded = await this.hasRespondedToTweet(tweet.id);

                    if(hasAlreadyResponded){
                        console.log(`Already responded to tweet: ${tweet.id}`);
                        continue;
                    }

                    await this.respondToTweet(tweet, formattedHomeTimeline);
                    await this.cacheTweet(tweet);
                    this.respondedTweets.add(tweet.id); // Mark as processed

                    // Set a random interval between 5 to 10 minutes
                    const randomInterval = Math.floor(Math.random() * (10 - 5 + 1) + 5) * 60 * 1000;
                    this.checkInterval = setTimeout(() => this.checkForNewTweetsLoop(), randomInterval);
                }
                // Save recent tweets to cache
                fs.writeFileSync("tweetcache/home_timeline.json", JSON.stringify(recentTweets, null, 2));
            } catch (error) {
                console.error(`Error fetching tweets for ${username}:`, error);
            }
        }
    }

    private async hasRespondedToTweet(tweetId: string): Promise<boolean> {
        try {

            if(this.respondedTweets.has(tweetId)) {
                return true;
            }

            let cachedTweet = await this.getCachedTweet(tweetId);

            if(cachedTweet) {
                return true;
            }

            return false;
        } catch (error) {
            console.error("An error occurred while executing HasRespondedToTweet:", error);
            return false;
        }
    }

    private async fetchUserTweets(username: string) {
        try {
            const response = this.twitterClient.getTweets(username, 20);
            if (response[Symbol.asyncIterator]) {
                const tweets: any[] = [];
                for await (const tweet of response) {
                    tweets.push(tweet);
                }
                return tweets;
            }
        } catch (error) {
            console.error(`Error fetching tweets for ${username}:`, error);
            return []; // Return an empty array on error
        }
    }

    private async respondToTweet(selectedTweet: any, formattedHomeTimeline: any) {
        if (!selectedTweet) {
            return console.log("No selected tweet found");
        }
        // disabling reply to retweet tweet
        if (selectedTweet.isRetweet) {
            return console.log("skipping as this tweet is retweeted:",selectedTweet?.id);
        }

        console.log("Selected tweet to reply to:", selectedTweet?.text);

        if (this.respondedTweets.has(selectedTweet.id)) {
            console.log("Already responded to this tweet:", selectedTweet.id);
            return;
        }
        const conversationId = selectedTweet.conversationId;
        const roomId = stringToUuid(
            conversationId + "-" + this.runtime.agentId
        );

        const userIdUUID = stringToUuid(selectedTweet.userId as string);

        await this.runtime.ensureConnection(
            userIdUUID,
            roomId,
            selectedTweet.username,
            selectedTweet.name,
            "twitter"
        );

        // Fetch replies and retweets
        const replies = selectedTweet.thread;
        const replyContext = replies
            .filter(
                (reply) =>
                    reply.username !==
                    this.runtime.getSetting("TWITTER_USERNAME")
            )
            .map((reply) => `@${reply.username}: ${reply.text}`)
            .join("\n");

        let tweetBackground = "";
        if (selectedTweet.isRetweet) {
            const originalTweet = await this.requestQueue.add(() =>
                this.twitterClient.getTweet(selectedTweet.id)
            );
            tweetBackground = `Retweeting @${originalTweet.username}: ${originalTweet.text}`;
        }

        if(!this.runtime)
        {
            console.warn("RUNTIME WAS NULL EVEN BEFORE");
        }
        else {
            console.warn("RUNTIME IS PROPERLY DEFINED");
        }

        // Generate image descriptions using GPT-4 vision API
        const imageDescriptions = [];
        for (const photo of selectedTweet.photos) {
            try {
                const description = await this.runtime
                    .getService(ServiceType.IMAGE_DESCRIPTION)
                    .getInstance<IImageDescriptionService>()
                    .describeImage(photo.url, this.runtime);
                imageDescriptions.push(description);
            } catch (error) {
                console.error(`Error describing image at ${photo.url}:`, error);
                imageDescriptions.push('null'); // or you can choose to skip this image
            }
        }

        // crawl additional conversation tweets, if there are any
        await buildConversationThread(selectedTweet, this);

        const message = {
            id: stringToUuid(selectedTweet.id + "-" + this.runtime.agentId),
            agentId: this.runtime.agentId,
            content: {
                text: selectedTweet.text,
                url: selectedTweet.permanentUrl,
                inReplyTo: selectedTweet.inReplyToStatusId
                    ? stringToUuid(
                            selectedTweet.inReplyToStatusId +
                                "-" +
                                this.runtime.agentId
                        )
                    : undefined,
            },
            userId: userIdUUID,
            roomId,
            // Timestamps are in seconds, but we need them in milliseconds
            createdAt: selectedTweet.timestamp * 1000,
        };

        if (!message.content.text) {
            return { text: "", action: "IGNORE" };
        }

        let state = await this.runtime.composeState(message, {
            twitterClient: this.twitterClient,
            twitterUserName: this.runtime.getSetting("TWITTER_USERNAME"),
            timeline: formattedHomeTimeline,
            tweetContext: `${tweetBackground}

            Original Post:
            By @${selectedTweet.username}
            ${selectedTweet.text}${replyContext.length > 0 && `\nReplies to original post:\n${replyContext}`}
            ${`Original post text: ${selectedTweet.text}`}
            ${selectedTweet.urls.length > 0 ? `URLs: ${selectedTweet.urls.join(", ")}\n` : ""}${imageDescriptions.length > 0 ? `\nImages in Post (Described): ${imageDescriptions.join(", ")}\n` : ""}
            `,
        });

        await this.saveRequestMessage(message, state as State);

        const context = composeContext({
            state,
            template:
                this.runtime.character.templates?.twitterSearchTemplate ||
                twitterSearchTemplate,
        });

        const responseContent = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.SMALL,
        });

        responseContent.inReplyTo = message.id;

        const response = responseContent;

        if (!response.text) {
            console.log("Returning: No response text found");
            return;
        }

        console.log(
            `Bot would respond to tweet ${selectedTweet.id} with: ${response.text}`
        );
        try {
            const callback: HandlerCallback = async (response: Content) => {
                const memories = await sendTweet(
                    this,
                    response,
                    message.roomId,
                    this.runtime.getSetting("TWITTER_USERNAME"),
                    selectedTweet.id
                );
                return memories;
            };

            const responseMessages = await callback(responseContent);

            state = await this.runtime.updateRecentMessageState(state);

            for (const responseMessage of responseMessages) {
                await this.runtime.messageManager.createMemory(
                    responseMessage,
                    false
                );
            }

            state = await this.runtime.updateRecentMessageState(state);

            await this.runtime.evaluate(message, state);

            await this.runtime.processActions(
                message,
                responseMessages,
                state,
                callback
            );

            this.respondedTweets.add(selectedTweet.id);
            const responseInfo = `Context:\n\n${context}\n\nSelected Post: ${selectedTweet.id} - ${selectedTweet.username}: ${selectedTweet.text}\nAgent's Output:\n${response.text}`;
            const debugFileName = `tweetcache/tweet_generation_${selectedTweet.id}.txt`;

            fs.writeFileSync(debugFileName, responseInfo);
            await wait();
        } catch (error) {
            console.error(`Error sending response post: ${error}`);
        }
    }
}
