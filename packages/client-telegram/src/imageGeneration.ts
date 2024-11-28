// Utility.ts
import { IAgentRuntime, ModelClass } from "@ai16z/eliza/src/types.ts";
import { generateText } from "@ai16z/eliza/src/generation.ts";

export class imageGeneration {
    static async DecideIfShouldGenerateImageForReply(runtime: IAgentRuntime, originalMessage: string, response: string){

        const decideIfShouldGenerateImagePrompt = await generateText({
            runtime: runtime,
            context: `
                You are an AI assistant that helps determine whether to include an image in Telegram replies. You will receive two inputs:
                1. The message you're replying to
                2. Your planned reply text
                
                Your task is to determine if adding an image would enhance the reply's effectiveness and engagement. 
                
                Output ONLY "true" or "false" based on these guidelines:
                
                Return true if:
                - The reply references visual content (e.g., "Here's what it looks like", "Check this out", "As shown here")
                - The original message asks for visual information (e.g., "Can anyone show me", "What does X look like")
                - The reply would benefit from data visualization (e.g., when discussing statistics, trends, or comparisons)
                - The reply explains something that would be clearer with a diagram or illustration
                - The reply suggests modifications to an image in the original message
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
                - The original message already contains the relevant image
                - The meme or reaction image might be inappropriate for the conversation's tone
                - The visual content would distract from a serious discussion
                
                Examples:
                
                Message you are replying to: "Does anyone know how to tie a bowline knot?"
                Reply: "Here's a step-by-step guide to tying a bowline knot. First you make a loop..."
                Decision: true (visual instruction would be helpful)
                
                Message you are replying to: "What do you think about the new tax policy?"
                Reply: "The policy seems well-intentioned but might have unintended consequences..."
                Decision: false (opinion-based discussion)
                
                Message you are replying to: "How has the market performed this quarter?"
                Reply: "Here's the quarterly breakdown showing a 15% increase..."
                Decision: true (data visualization would enhance understanding)
                
                Message you are replying to: "Thanks for your help yesterday!"
                Reply: "You're welcome! Glad I could assist."
                Decision: false (purely conversational)
                
                Message you are replying to: "This project is driving me crazy!"
                Reply: "Me trying to debug my code at 3am..."
                Decision: true (perfect opportunity for a relatable meme)
                
                Message you are replying to: "Just achieved a personal best in my marathon training!"
                Reply: "So proud! Just finished my run too, feeling amazing!"
                Decision: true (sharing a post-run selfie would enhance the celebration)
                
                Message you are replying to: "Anyone else working through this heatwave?"
                Reply: "Living my best life with three fans pointed at my desk right now"
                Decision: true (humorous situation perfect for a selfie or reaction image)
                
                Message you are replying to: "New movie was mid tbh"
                Reply: "The critics watching that finale like..."
                Decision: true (reaction meme would enhance the critique)
                    
                Now make a Decision based on the following data:
                Message you are replying to:
                ${originalMessage}
                
                Reply:
                ${response}
                    
                You are only allowed to reply 'true' or 'false'.
                `,
            modelClass: ModelClass.MEDIUM,
        });

        return decideIfShouldGenerateImagePrompt;
    }
}

export default imageGeneration;