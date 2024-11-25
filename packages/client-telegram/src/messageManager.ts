import { Message } from "@telegraf/types";
import { Context, Telegraf, Input } from "telegraf";

import { composeContext } from "@ai16z/eliza/src/context.ts";
import { embeddingZeroVector } from "@ai16z/eliza/src/memory.ts";
import {
    Content,
    HandlerCallback,
    IAgentRuntime,
    IImageDescriptionService,
    Memory,
    ModelClass,
    State,
    UUID,
} from "@ai16z/eliza/src/types.ts";
import { stringToUuid } from "@ai16z/eliza/src/uuid.ts";

import {
    generateImage,
    generateMessageResponse,
    generateShouldRespond, generateText,
} from "@ai16z/eliza/src/generation.ts";
import {
    messageCompletionFooter,
    shouldRespondFooter,
} from "@ai16z/eliza/src/parsing.ts";
import ImageDescriptionService from "@ai16z/plugin-node/src/services/image.ts";

const MAX_MESSAGE_LENGTH = 4096; // Telegram's max message length

const telegramShouldRespondTemplate =
    `# Task: Decide if {{agentName}} should respond.
About {{agentName}}:
{{bio}}

# INSTRUCTIONS: Determine if {{agentName}} should respond to the message and participate in the conversation. Do not comment. Just respond with "RESPOND" or "IGNORE" or "STOP".

# RESPONSE EXAMPLES
<user 1>: I just saw a really great movie
<user 2>: Oh? Which movie?
Result: [IGNORE]

{{agentName}}: Oh, this is my favorite scene
<user 1>: sick
<user 2>: wait, why is it your favorite scene
Result: [RESPOND]

<user>: stfu bot
Result: [STOP]

<user>: Hey {{agent}}, can you help me with something
Result: [RESPOND]

<user>: {{agentName}} stfu plz
Result: [STOP]

<user>: i need help
{{agentName}}: how can I help you?
<user>: no. i need help from someone else
Result: [IGNORE]

<user>: Hey {{agent}}, can I ask you a question
{{agentName}}: Sure, what is it
<user>: can you ask claude to create a basic react module that demonstrates a counter
Result: [RESPOND]

<user>: {{agentName}} can you tell me a story
<user>: {about a girl named elara
{{agentName}}: Sure.
{{agentName}}: Once upon a time, in a quaint little village, there was a curious girl named Elara.
{{agentName}}: Elara was known for her adventurous spirit and her knack for finding beauty in the mundane.
<user>: I'm loving it, keep going
Result: [RESPOND]

<user>: {{agentName}} stop responding plz
Result: [STOP]

<user>: okay, i want to test something. can you say marco?
{{agentName}}: marco
<user>: great. okay, now do it again
Result: [RESPOND]

Response options are [RESPOND], [IGNORE] and [STOP].

{{agentName}} is in a room with other users and is very worried about being annoying and saying too much.
Respond with [RESPOND] to messages that are directed at {{agentName}}, or participate in conversations that are interesting or relevant to their background.
If a message is not interesting or relevant, respond with [IGNORE]
Unless directly responding to a user, respond with [IGNORE] to messages that are very short or do not contain much information.
If a user asks {{agentName}} to be quiet, respond with [STOP]
If {{agentName}} concludes a conversation and isn't part of the conversation anymore, respond with [STOP]

IMPORTANT: {{agentName}} is particularly sensitive about being annoying, so if there is any doubt, it is better to respond with [IGNORE].
If {{agentName}} is conversing with a user and they have not asked to stop, it is better to respond with [RESPOND].

{{recentMessages}}

# INSTRUCTIONS: Choose the option that best describes {{agentName}}'s response to the last message. Ignore messages if they are addressed to someone else.
` + shouldRespondFooter;

const telegramMessageHandlerTemplate =
    // {{goals}}
    `# Action Examples
{{actionExamples}}
(Action examples are for reference only. Do not use the information from them in your response.)

# Knowledge
{{knowledge}}

# Task: Generate dialog and actions for the character {{agentName}}.
About {{agentName}}:
{{bio}}
{{lore}}

Examples of {{agentName}}'s dialog and actions:
{{characterMessageExamples}}

{{providers}}

{{attachments}}

{{actions}}

# Capabilities
Note that {{agentName}} is capable of reading/seeing/hearing various forms of media, including images, videos, audio, plaintext and PDFs. Recent attachments have been included above under the "Attachments" section.

{{messageDirections}}

{{recentMessages}}

# Instructions: Write the next message for {{agentName}}. Include an action, if appropriate. {{actionNames}}
` + messageCompletionFooter;

export class MessageManager {
    public bot: Telegraf<Context>;
    private runtime: IAgentRuntime;
    private imageService: IImageDescriptionService;

    constructor(bot: Telegraf<Context>, runtime: IAgentRuntime) {
        this.bot = bot;
        this.runtime = runtime;
        this.imageService = ImageDescriptionService.getInstance();
    }

    // Process image messages and generate descriptions
    private async processImage(
        message: Message
    ): Promise<{ description: string } | null> {
        // console.log(
        //     "🖼️ Processing image message:",
        //     JSON.stringify(message, null, 2)
        // );

        try {
            let imageUrl: string | null = null;

            // Handle photo messages
            if ("photo" in message && message.photo?.length > 0) {
                const photo = message.photo[message.photo.length - 1];
                const fileLink = await this.bot.telegram.getFileLink(
                    photo.file_id
                );
                imageUrl = fileLink.toString();
            }
            // Handle image documents
            else if (
                "document" in message &&
                message.document?.mime_type?.startsWith("image/")
            ) {
                const doc = message.document;
                const fileLink = await this.bot.telegram.getFileLink(
                    doc.file_id
                );
                imageUrl = fileLink.toString();
            }

            if (imageUrl) {
                const { title, description } = await this.imageService
                    .getInstance()
                    .describeImage(imageUrl);
                const fullDescription = `[Image: ${title}\n${description}]`;
                return { description: fullDescription };
            }
        } catch (error) {
            console.error("❌ Error processing image:", error);
        }

        return null; // No image found
    }

    // Decide if the bot should respond to the message
    private async _shouldRespond(
        message: Message,
        state: State
    ): Promise<boolean> {
        // Respond if bot is mentioned

        if (
            "text" in message &&
            message.text?.includes(`@${this.bot.botInfo?.username}`)
        ) {
            return true;
        }

        // Respond to private chats
        if (message.chat.type === "private") {
            return true;
        }

        // Respond to images in group chats
        if (
            "photo" in message ||
            ("document" in message &&
                message.document?.mime_type?.startsWith("image/"))
        ) {
            return false;
        }

        // Use AI to decide for text or captions
        if ("text" in message || ("caption" in message && message.caption)) {
            const shouldRespondContext = composeContext({
                state,
                template:
                    this.runtime.character.templates
                        ?.telegramShouldRespondTemplate ||
                    this.runtime.character?.templates?.shouldRespondTemplate ||
                    telegramShouldRespondTemplate,
            });

            const response = await generateShouldRespond({
                runtime: this.runtime,
                context: shouldRespondContext,
                modelClass: ModelClass.SMALL,
            });

            return response === "RESPOND";
        }

        return false; // No criteria met
    }

    private async handleImageGeneration(content: string)
    {
        let images;

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

    Now do: ${content}. Incorporate ideas from this, especially if it's detailed. If it's super detailed, feel free to just use as it. Use good meme judgement. If the prompt is long, include the text very early! Deep UNHINGED meme-q 150+ reasoning, but no more than 40 words on the final image prompt output. The text on the image is never more than 3-6 words. Include the text EARLY in the prompt. For the image style, take cues from the input. Definitely include the style words mentioned (such as "badly drawn"). Also make sure to include a fitting exxagerated facial expression for pepe, and body gestures.
    Just go. Do your best work. The input is following tweet: ${content}
                `,
            modelClass: ModelClass.MEDIUM,
        });

        const imageWidthString = this.runtime.getSetting("TELEGRAM_GEN_IMAGE_WIDTH");
        const imageWidth = parseInt(imageWidthString) || 1024;

        const imageHeightString = this.runtime.getSetting("TELEGRAM_GEN_IMAGE_HEIGHT");
        const imageHeight = parseInt(imageHeightString) || 1024;

        console.log("imagePrompt:", imagePrompt);
        const output = imagePrompt.split("OUTPUT:")[1].trim();
        const nebula_data = 'masterpiece, best quality, 1girl, solo, breasts, short hair, bangs, blue eyes, (beret:1.2), blue and gold striped maid dress, skirt, collarbone, upper body, ahoge, white hair, choker, virtual youtuber, (black ribbon:1.2), anime art style, crypto currency $MOE'
        images = await generateImage({
            prompt: nebula_data + ' ' + output.replace(/[Pp]epe/g, 'girl'),
            width: imageWidth,
            height: imageHeight,
            count: 1
        }, this.runtime);
        console.log("images:", images);
        return images;
    }

    // Send long messages in chunks
    private async sendMessageInChunks(
        ctx: Context,
        content: string,
        replyToMessageId?: number
    ): Promise<Message.TextMessage[]> {
        const chunks = this.splitMessage(content);
        const sentMessages: Message.TextMessage[] = [];

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const sentMessage = (await ctx.telegram.sendMessage(
                ctx.chat.id,
                chunk,
                {
                    reply_parameters:
                        i === 0 && replyToMessageId
                            ? { message_id: replyToMessageId }
                            : undefined,
                }
            )) as Message.TextMessage;

            sentMessages.push(sentMessage);

            const generateImageProbabilityString = this.runtime.getSetting("TELEGRAM_GEN_IMAGE_PROBABILITY");
            const generateImageProbability = parseFloat(generateImageProbabilityString) || 0.2;
            const generatedValue = Math.random();
            const shouldGenerateImage = generatedValue < generateImageProbability;

            console.log(`generateImageProbability: ${generateImageProbability}, generatedValue: ${generatedValue}, shouldGenerateImage: ${shouldGenerateImage}`);

            if(shouldGenerateImage) {
                const imageBase64 = await this.handleImageGeneration(sentMessage.text)
                const base64Image = imageBase64.data ? imageBase64.data[0] : null;
                const base64Data = base64Image.replace(/^data:image\/[a-z]+;base64,/, "");
                const imageBuffer = Buffer.from(base64Data, 'base64');

                await ctx.sendPhoto(Input.fromBuffer(imageBuffer));
            }
        }

        return sentMessages;
    }

    // Split message into smaller parts
    private splitMessage(text: string): string[] {
        const chunks: string[] = [];
        let currentChunk = "";

        const lines = text.split("\n");
        for (const line of lines) {
            if (currentChunk.length + line.length + 1 <= MAX_MESSAGE_LENGTH) {
                currentChunk += (currentChunk ? "\n" : "") + line;
            } else {
                if (currentChunk) chunks.push(currentChunk);
                currentChunk = line;
            }
        }

        if (currentChunk) chunks.push(currentChunk);
        return chunks;
    }

    // Generate a response using AI
    private async _generateResponse(
        message: Memory,
        state: State,
        context: string
    ): Promise<Content> {
        const { userId, roomId } = message;

        const response = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.SMALL,
        });

        if (!response) {
            console.error("❌ No response from generateMessageResponse");
            return null;
        }
        await this.runtime.databaseAdapter.log({
            body: { message, context, response },
            userId: userId,
            roomId,
            type: "response",
        });

        return response;
    }

    // Main handler for incoming messages
    public async handleMessage(ctx: Context): Promise<void> {
        if (!ctx.message || !ctx.from) {
            return; // Exit if no message or sender info
        }

        // TODO: Handle commands?
        // if (ctx.message.text?.startsWith("/")) {
        //     return;
        // }

        const message = ctx.message;

        try {
            // Convert IDs to UUIDs
            const userId = stringToUuid(ctx.from.id.toString()) as UUID;
            const userName =
                ctx.from.username || ctx.from.first_name || "Unknown User";
            const chatId = stringToUuid(
                ctx.chat?.id.toString() + "-" + this.runtime.agentId
            ) as UUID;
            const agentId = this.runtime.agentId;
            const roomId = chatId;

            await this.runtime.ensureConnection(
                userId,
                roomId,
                userName,
                userName,
                "telegram"
            );

            const messageId = stringToUuid(
                message.message_id.toString() + "-" + this.runtime.agentId
            ) as UUID;

            // Handle images
            const imageInfo = await this.processImage(message);

            // Get text or caption
            let messageText = "";
            if ("text" in message) {
                messageText = message.text;
            } else if ("caption" in message && message.caption) {
                messageText = message.caption;
            }

            // Combine text and image description
            const fullText = imageInfo
                ? `${messageText} ${imageInfo.description}`
                : messageText;

            if (!fullText) {
                return; // Skip if no content
            }

            const content: Content = {
                text: fullText,
                source: "telegram",
                inReplyTo:
                    "reply_to_message" in message && message.reply_to_message
                        ? stringToUuid(
                              message.reply_to_message.message_id.toString() +
                                  "-" +
                                  this.runtime.agentId
                          )
                        : undefined,
            };

            // Create memory for the message
            const memory: Memory = {
                id: messageId,
                agentId,
                userId,
                roomId,
                content,
                createdAt: message.date * 1000,
                embedding: embeddingZeroVector,
            };

            await this.runtime.messageManager.createMemory(memory);

            // Update state with the new memory
            let state = await this.runtime.composeState(memory);
            state = await this.runtime.updateRecentMessageState(state);

            // Decide whether to respond
            const shouldRespond = await this._shouldRespond(message, state);
            if (shouldRespond) {
                // Generate response
                const context = composeContext({
                    state,
                    template:
                        this.runtime.character.templates
                            ?.telegramMessageHandlerTemplate ||
                        this.runtime.character?.templates
                            ?.messageHandlerTemplate ||
                        telegramMessageHandlerTemplate,
                });

                const responseContent = await this._generateResponse(
                    memory,
                    state,
                    context
                );

                if (!responseContent || !responseContent.text) return;

                // Send response in chunks
                const callback: HandlerCallback = async (content: Content) => {
                    const sentMessages = await this.sendMessageInChunks(
                        ctx,
                        content.text,
                        message.message_id
                    );

                    const memories: Memory[] = [];

                    // Create memories for each sent message
                    for (let i = 0; i < sentMessages.length; i++) {
                        const sentMessage = sentMessages[i];
                        const isLastMessage = i === sentMessages.length - 1;

                        const memory: Memory = {
                            id: stringToUuid(
                                sentMessage.message_id.toString() +
                                    "-" +
                                    this.runtime.agentId
                            ),
                            agentId,
                            userId,
                            roomId,
                            content: {
                                ...content,
                                text: sentMessage.text,
                                action: !isLastMessage ? "CONTINUE" : undefined,
                                inReplyTo: messageId,
                            },
                            createdAt: sentMessage.date * 1000,
                            embedding: embeddingZeroVector,
                        };

                        await this.runtime.messageManager.createMemory(memory);
                        memories.push(memory);
                    }

                    return memories;
                };

                // Execute callback to send messages and log memories
                const responseMessages = await callback(responseContent);

                // Update state after response
                state = await this.runtime.updateRecentMessageState(state);

                // Handle any resulting actions
                await this.runtime.processActions(
                    memory,
                    responseMessages,
                    state,
                    callback
                );
            }

            await this.runtime.evaluate(memory, state, shouldRespond);
        } catch (error) {
            console.error("❌ Error handling message:", error);
            console.error("Error sending message:", error);
        }
    }
}