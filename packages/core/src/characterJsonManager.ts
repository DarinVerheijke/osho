import fs from "fs";
import { Character } from "./types.ts";
import path from "path";

const rudeLoreFileName: string = "rudeLore.txt"
const cuteLoreFileName: string = "cuteLore.txt"

const rudeBioFileName: string = "rudeBio.txt"
const cuteBioFileName: string = "cuteBio.txt"

const rudeMessageExamplesFileName: string = "rudeMessageExamples.txt"
const cuteMessageExamplesFileName: string = "cuteMessageExamples.txt"

const rudePostExamplesFileName: string = "rudePostExamples.txt"
const cutePostExamplesFileName: string = "cutePostExamples.txt"

const cuteAdjectivesFileName: string = "cuteAdjectives.txt"
const rudeAdjectivesFileName: string = "rudeAdjectives.txt"

const cuteTopicsFileName: string = "cuteTopics.txt"
const rudeTopicsFileName: string = "rudeTopics.txt"

const cuteStylesFileName: string = "cuteStyle.txt"
const rudeStylesFileName: string = "rudeStyle.txt"

const pathToBiosRoot: string = "../../CharacterJson/bios/"
const pathToLoresRoot: string = "../../CharacterJson/lores/"
const pathToMessageExamplesRoot: string = "../../CharacterJson/messageExamples/"
const pathToPostExamplesRoot: string = "../../CharacterJson/postExamples/"
const pathToAdjectivesRoot: string = "../../CharacterJson/adjectives/"
const pathToTopicsRoot: string = "../../CharacterJson/topics/"
const pathToStylesRoot: string = "../../CharacterJson/styles/"

export class characterJsonManager {
    static async getDefaultCharacter(character: Character): Promise<Character> {
        return await characterJsonManager.getCuteCharacter(character);
    }

    static async getRudeCharacter(character: Character): Promise<Character> {
        return await characterJsonManager.getCharacter(character,
            rudeBioFileName,
            rudeLoreFileName,
            rudeMessageExamplesFileName,
            rudePostExamplesFileName,
            rudeAdjectivesFileName,
            rudeTopicsFileName,
            rudeStylesFileName
        );
    }

    static async getCuteCharacter(character: Character): Promise<Character> {
        return await characterJsonManager.getCharacter(character,
            cuteBioFileName,
            cuteLoreFileName,
            cuteMessageExamplesFileName,
            cutePostExamplesFileName,
            cuteAdjectivesFileName,
            cuteTopicsFileName,
            cuteStylesFileName
        );
    }

    static async getCharacter(character: Character,
                              bioFileName : string,
                              loreFileName : string,
                              messageExamplesFileName : string,
                              postExamplesFileName : string,
                              adjectivesFileName : string,
                              topicsFileName : string,
                              stylesFileName : string
    ): Promise<Character>  {

        try {
            const modifiedCharacter = structuredClone(character);
            const fullPathToBio = path.join(pathToBiosRoot, bioFileName);
            const fullPathToLore = path.join(pathToLoresRoot, loreFileName);
            const fullPathToMessageExamples = path.join(pathToMessageExamplesRoot, messageExamplesFileName);
            const fullPathToPostExamples = path.join(pathToPostExamplesRoot, postExamplesFileName);
            const fullPathToAdjectives = path.join(pathToAdjectivesRoot, adjectivesFileName);
            const fullPathToTopics = path.join(pathToTopicsRoot, topicsFileName);
            const fullPathToStyles = path.join(pathToStylesRoot, stylesFileName);

            const bio = await characterJsonManager.getFileContent(fullPathToBio);
            const lore = await characterJsonManager.getFileContent(fullPathToLore);
            const messageExamples = await characterJsonManager.getFileContent(fullPathToMessageExamples);
            const postExamples = await characterJsonManager.getFileContent(fullPathToPostExamples);
            const adjectives = await characterJsonManager.getFileContent(fullPathToAdjectives);
            const topics = await characterJsonManager.getFileContent(fullPathToTopics);
            const styles = await characterJsonManager.getFileContent(fullPathToStyles);

            const bioArray = JSON.parse(bio);
            const loreArray = JSON.parse(lore);
            const messageExamplesObject = JSON.parse(messageExamples);
            const postExamplesObject = JSON.parse(postExamples);
            const adjectivesObject = JSON.parse(adjectives);
            const topicsObject = JSON.parse(topics);
            const stylesObject = JSON.parse(styles);

            modifiedCharacter.bio = bioArray;
            modifiedCharacter.lore = loreArray;
            modifiedCharacter.messageExamples = messageExamplesObject;
            modifiedCharacter.postExamples = postExamplesObject;
            modifiedCharacter.adjectives = adjectivesObject;
            modifiedCharacter.topics = topicsObject;
            modifiedCharacter.style = stylesObject;

            return modifiedCharacter;
        } catch (error) {
            console.error("Error processing character:", error);
            throw error;
        }
    }

    static async getFileContent(pathToFile: string) {
        try {
            const data = fs.readFileSync(pathToFile, 'utf8');
            return data;
        } catch (err) {
            console.error(`Error reading file '${pathToFile}', Error: ${err}`);
        }

        return '';
    }
}