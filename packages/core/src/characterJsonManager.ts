import fs from "fs";
import { Character } from "./types.ts";
import path from "path";

const rudeLoreFileName: string = "rudeLore.txt"
const cuteLoreFileName: string = "cuteLore.txt"
const rudeBioFileName: string = "rudeBio.txt"
const cuteBioFileName: string = "cuteBio.txt"
const pathToBiosRoot: string = "../../CharacterJson/bios/"
const pathToTemplateFile: string = "../../CharacterJson/template.txt"

export class characterJsonManager {
    static async getDefaultCharacter() : Promise<Character>{
        return await characterJsonManager.getCuteCharacter();
    }

    static async getRudeCharacter() : Promise<Character>{
        return await characterJsonManager.getCharacter(rudeBioFileName , rudeLoreFileName);
    }

    static async getCuteCharacter() : Promise<Character>{
        return await characterJsonManager.getCharacter(cuteBioFileName, cuteLoreFileName);
    }

    static async getCharacter(bioFileName : string, loreFileName : string) : Promise<Character>{
        const fullPathToBio = path.join(pathToBiosRoot, bioFileName);
        const fullPathToLore = path.join(pathToBiosRoot, loreFileName);

        const jsonTemplate = await characterJsonManager.getFileContent(pathToTemplateFile);

        const bio = await characterJsonManager.getFileContent(fullPathToBio);
        const lore = await characterJsonManager.getFileContent(fullPathToLore);

        let resultJson = jsonTemplate.replace('{bio}', bio);
        resultJson = resultJson.replace('{lore}', lore);
        const character = JSON.parse(resultJson);
        return character;
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