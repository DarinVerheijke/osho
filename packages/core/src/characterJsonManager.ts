import fs from "fs";
import { Character } from "./types.ts";
import path from "path";

const rudeLoreFileName: string = "rudeLore.txt"
const cuteLoreFileName: string = "cuteLore.txt"
const rudeBioFileName: string = "rudeBio.txt"
const cuteBioFileName: string = "cuteBio.txt"
const pathToBiosRoot: string = "../../CharacterJson/bios/"
const pathToLoresRoot: string = "../../CharacterJson/lores/"

export class characterJsonManager {
    static async getDefaultCharacter(character: Character): Promise<Character> {
        return await characterJsonManager.getCuteCharacter(character);
    }

    static async getRudeCharacter(character: Character): Promise<Character> {
        return await characterJsonManager.getCharacter(character, rudeBioFileName , rudeLoreFileName);
    }

    static async getCuteCharacter(character: Character): Promise<Character> {
        return await characterJsonManager.getCharacter(character, cuteBioFileName, cuteLoreFileName);
    }

    static async getCharacter(character: Character, bioFileName : string, loreFileName : string): Promise<Character>  {

        try {
            const modifiedCharacter = structuredClone(character);
            const fullPathToBio = path.join(pathToBiosRoot, bioFileName);
            const fullPathToLore = path.join(pathToLoresRoot, loreFileName);

            const bio = await characterJsonManager.getFileContent(fullPathToBio);
            const lore = await characterJsonManager.getFileContent(fullPathToLore);

            const bioArray = characterJsonManager.splitIntoArray(bio);
            const loreArray = characterJsonManager.splitIntoArray(lore);

            modifiedCharacter.bio = bioArray;
            modifiedCharacter.lore = loreArray;

            return modifiedCharacter;
        } catch (error) {
            console.error("Error processing character:", error);
            throw error;
        }
    }

    static splitIntoArray(input: string) {
        if (!input || typeof input !== 'string') return [];

        return input
            .split(',')
            .map(str => str.trim())
            .filter(str => str.length > 0)
            .map(str => str.replace(/\n|\r/g, ' ').replace(/\s+/g, ' '));
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