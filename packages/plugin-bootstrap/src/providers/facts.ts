import { embed } from "@ai16z/eliza/src/embedding.ts";
import { MemoryManager } from "@ai16z/eliza/src/memory.ts";
import { formatMessages } from "@ai16z/eliza/src/messages.ts";
import {
    IAgentRuntime,
    Memory,
    Provider,
    State,
} from "@ai16z/eliza/src/types.ts";
import { formatFacts } from "../evaluators/fact.ts";

const factsProvider: Provider = {
    get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        const recentMessagesData = state?.recentMessagesData?.slice(-10);

        const recentMessages = formatMessages({
            messages: recentMessagesData,
            actors: state?.actorsData,
        });

        const embedding = await embed(runtime, recentMessages);

        const memoryManager = new MemoryManager({
            runtime,
            tableName: "facts",
        });

        let fetchRelevantFactsAmountString = runtime.getSetting("FETCH_RELEVANT_FACTS_AMOUNT")
        let fetchRelevantFactsAmount = parseInt(fetchRelevantFactsAmountString) || 10;

        const relevantFacts = await memoryManager.searchMemoriesByEmbedding
        (
             embedding,
             {
                 roomId: message.roomId,
                 count: fetchRelevantFactsAmount,
                 agentId: runtime.agentId,
             }
         );

        console.log("fetchRelevantFactsAmount: ", fetchRelevantFactsAmount);
        console.log(`\n\n==============RELEVANT FACTS START==============:\n${relevantFacts}\n==============RELEVANT FACTS END==============\n\n`);

        let fetchRecentFactsAmountString = runtime.getSetting("FETCH_RECENT_FACTS_AMOUNT")
        let fetchRecentFactsAmount = parseInt(fetchRecentFactsAmountString) || 10;

        const recentFactsData = await memoryManager.getMemories({
            roomId: message.roomId,
            count: fetchRecentFactsAmount,
            agentId: runtime.agentId,
        });

        console.log("fetchRecentFactsAmount: ", fetchRecentFactsAmount);
        console.log(`\n\n==============RECENT FACTS START==============:\n${recentFactsData}\n==============RECENT FACTS END==============\n\n`);

        // join the two and deduplicate
        const allFacts = [...relevantFacts, ...recentFactsData].filter(
            (fact, index, self) =>
                index === self.findIndex((t) => t.id === fact.id)
        );

        const formattedFacts = formatFacts(allFacts);

        return "Key facts that {{agentName}} knows:\n{{formattedFacts}}"
            .replace("{{agentName}}", runtime.character.name)
            .replace("{{formattedFacts}}", formattedFacts);
    },
};

export { factsProvider };
