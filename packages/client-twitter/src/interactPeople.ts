import { IAgentRuntime, Content, HandlerCallback, State, ModelClass, ServiceType, IImageDescriptionService } from "@ai16z/eliza/src/types.ts";
import { stringToUuid } from "@ai16z/eliza/src/uuid.ts";
import fs from "fs";
import { characterJsonManager } from "@ai16z/eliza/src/characterJsonManager.ts";
import { composeContext } from "@ai16z/eliza/src/context.ts";
import { wait, sendTweet, buildConversationThread } from "./utils.ts"; // Adjust the import path as necessary
import { generateImage, generateMessageResponse, generateText } from "@ai16z/eliza/src/generation.ts";
import { ClientBase } from "./base.ts";
import { messageCompletionFooter } from "@ai16z/eliza/src/parsing.ts";
import { settings } from "@ai16z/eliza";

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
    private currentResponseIndex: number = 0;

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

                let respondMinDelaySecondsString = this.runtime.getSetting("TWITTER_RESPOND_MIN_DELAY_SECONDS");
                let respondMaxDelaySecondsString = this.runtime.getSetting("TWITTER_RESPOND_MAX_DELAY_SECONDS");

                let respondMinDelaySeconds = parseInt(respondMinDelaySecondsString) || 1000;
                let respondMaxDelaySeconds = parseInt(respondMaxDelaySecondsString) || 2000;

                for (const tweet of recentTweets) {

                    let hasAlreadyResponded = await this.hasRespondedToTweet(tweet.id);

                    if(hasAlreadyResponded){
                        console.log(`Already responded to tweet: ${tweet.id}`);
                        continue;
                    }

                    await this.respondToTweet(tweet, formattedHomeTimeline);
                    await this.cacheTweet(tweet);
                    this.respondedTweets.add(tweet.id); // Mark as processed

                    const randomInterval = this.getRandomInterval(respondMinDelaySeconds, respondMaxDelaySeconds);
                    console.log(`Waiting for ${randomInterval / 1000} seconds before processing the next tweet.`);
                    await this.delay(randomInterval); // Delay before processing the next tweet
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
            let fetchTweetsAmountString = this.runtime.getSetting("TWITTER_FETCH_TWEETS_AMOUNT")
            let fetchTweetsAmount = parseInt(fetchTweetsAmountString) || 5;

            const response = this.twitterClient.getTweets(username, fetchTweetsAmount);
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


    private async DecideIfShouldGenerateImage(usersTweetText: string, yourTweetText: string) {

        const decideIfShouldGenerateImageResponse = await generateText({
            runtime: this.runtime,
            context: `
                You are an AI assistant that helps determine whether to include an image in Twitter replies. You will receive two inputs:
                1. The tweet you're replying to
                2. Your planned reply text
                
                Your task is to determine if adding an image would enhance the reply's effectiveness and engagement. 
                
                Output ONLY "true" or "false" based on these guidelines:
                
                Return true if:
                - The reply references visual content (e.g., "Here's what it looks like", "Check this out", "As shown here")
                - The original tweet asks for visual information (e.g., "Can anyone show me", "What does X look like")
                - The reply would benefit from data visualization (e.g., when discussing statistics, trends, or comparisons)
                - The reply explains something that would be clearer with a diagram or illustration
                - The reply suggests modifications to an image in the original tweet
                - The reply expresses emotions that could be reinforced with a reaction image or selfie (e.g., excitement, surprise, confusion)
                - The situation calls for a meme that would enhance humor or relatability
                - The reply describes a personal action or state that could be visualized (e.g., "Working from the beach today", "Just finished this project")
                - The content could become a memorable or shareable moment
                - The reply would have more impact with visual emphasis (e.g., celebrating achievements, showing support)
                
                Return false if:
                - The reply is purely conversational or text-based
                - The reply is answering a non-visual question
                - The reply contains sensitive or controversial content
                - The reply is expressing an opinion or emotion that doesn't require visual support
                - The reply is providing factual information that's better conveyed through text
                - The original tweet already contains the relevant image
                - The meme or reaction image might be inappropriate for the conversation's tone
                - The visual content would distract from a serious discussion
                
                Examples:
                
                Tweet: "Does anyone know how to tie a bowline knot?"
                Reply: "Here's a step-by-step guide to tying a bowline knot. First you make a loop..."
                Decision: true (visual instruction would be helpful)
                
                Tweet: "What do you think about the new tax policy?"
                Reply: "The policy seems well-intentioned but might have unintended consequences..."
                Decision: false (opinion-based discussion)
                
                Tweet: "How has the market performed this quarter?"
                Reply: "Here's the quarterly breakdown showing a 15% increase..."
                Decision: true (data visualization would enhance understanding)
                
                Tweet: "Thanks for your help yesterday!"
                Reply: "You're welcome! Glad I could assist."
                Decision: false (purely conversational)
                
                Tweet: "This project is driving me crazy!"
                Reply: "Me trying to debug my code at 3am..."
                Decision: true (perfect opportunity for a relatable meme)
                
                Tweet: "Just achieved a personal best in my marathon training!"
                Reply: "So proud! Just finished my run too, feeling amazing!"
                Decision: true (sharing a post-run selfie would enhance the celebration)
                
                Tweet: "Anyone else working through this heatwave?"
                Reply: "Living my best life with three fans pointed at my desk right now"
                Decision: true (humorous situation perfect for a selfie or reaction image)
                
                Tweet: "New movie was mid tbh"
                Reply: "The critics watching that finale like..."
                Decision: true (reaction meme would enhance the critique)
                    
                Now make a Decision based on the following data:
                This is the tweet you're replying to:
                ${usersTweetText}
                
                This is the planned tweet:
                ${yourTweetText}
                    
                You are only allowed to reply 'true' or 'false'.
                `,
            modelClass: ModelClass.MEDIUM,
        });

        return decideIfShouldGenerateImageResponse;
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

        // Generate image descriptions using GPT-4 vision API
        const imageDescriptions = [];
        for (const photo of selectedTweet.photos) {
            try {
                const description = await this.runtime
                    .getService(ServiceType.IMAGE_DESCRIPTION)
                    .getInstance<IImageDescriptionService>()
                    .describeImage(photo.url);
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

        let cuteCharacter = await characterJsonManager.getCuteCharacter();

        let state = await this.runtime.composeState(message, cuteCharacter,{
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

        this.currentResponseIndex++;
        const aiDecidesEveryXPostsString = this.runtime.getSetting("TWITTER_AI_DECIDES_IMAGE_GEN_EVERY_X_MESSAGES_POSTS");
        const aiDecidesEveryXPosts = parseInt(aiDecidesEveryXPostsString) || 4;
        const canAIDecide = this.currentResponseIndex % aiDecidesEveryXPosts === 0;

        console.log("currentResponseIndex: ", this.currentResponseIndex);
        console.log("aiDecidesEveryXPostsString: ", aiDecidesEveryXPostsString);
        console.log("canAIDecide to generate image?: ", canAIDecide);

        let shouldGenerateImage = false;

        if(canAIDecide) {
            shouldGenerateImage = await this.DecideIfShouldGenerateImage(message.content.text, response.text) === 'true';
        }

        console.log("shouldGenerateImage: ", shouldGenerateImage);


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
    We recall: Pepe memes are funny because they encapsulate complex human emotions in a simple, expressive character. The versatility of Pepe’s facial and bodily expressions allows for a wide range of emotional portrayals—from joy and triumph to sadness and frustration—which makes the memes highly relatable. Humor often arises from placing Pepe in absurd or exaggerated contexts that resonate with internet culture and current events. A good Pepe meme effectively combines a recognizable emotional expression with a clever or ironic twist, portraying Pepe as a tragic and unhinged hero, enhancing its shareability and impact.
    Here's how you're going to output your work:
    INPUT: the request/idea/concept
    REASONING: 100 words of deep advanced unhinged meme reasoning on how to tickle a meme image idea from this, and what the meme needs to encapsulate to "hurt real good" and be aptly succint with respect to the input idea. 
    OUTPUT: your image prompt, as shown above. 
    Important Hint: there is no need to hold back here. We're in deep memetic territory. Your reasoning will make you a subject matter expert on the most obscure topics, so the memes will hit for whatever content is provided. Good memes hurt a little, such truth is contained in them. Do not include too many thoughts on correctness in your reasoning, reason deeply about how to make the best possible hardcore meme instead. The text you include should be ideally something that Pepe says, but it does not have to be in a speech bubble. A good image prompt is SIMPLE and APT, and includes all relevant details to make the input recognizable. 

    Now generate an image on an original input from a user that requested you to do this and your own response to that request:
    
    ORIGINAL REQUEST: '${selectedTweet.text}' by a user @${selectedTweet.username};
    YOUR RESPONSE: '${response.text}'

    Incorporate ideas from this, especially if it's detailed. If it's super detailed, feel free to just use as it. Use good meme judgement. If the prompt is long, include the text very early! Deep UNHINGED meme-q 150+ reasoning, but no more than 40 words on the final image prompt output. The text on the image is never more than 3-6 words. Include the text EARLY in the prompt. For the image style, take cues from the input. Definitely include the style words mentioned (such as "badly drawn"). Also make sure to include a fitting exaggerated facial expression for pepe, and body gestures.
    Just go. Do your best work.
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

        console.log(`Bot would respond to tweet ${selectedTweet.id} with: \n${response}`

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
