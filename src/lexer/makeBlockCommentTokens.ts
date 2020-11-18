import { createToken, TokenType } from "chevrotain";
import { makePayloadPattern } from "./makePayloadPattern";
import { BlockCommentStart, BlockCommentEnd } from "./tokens";

export interface BlockCommentTokenConfiguration {
  canNest: boolean;
}

export interface BlockCommentTokenPayload
  extends BlockCommentTokenConfiguration {
  endToken: TokenType;
}

export function makeBlockCommentTokens(
  startPattern: RegExp,
  endPattern: RegExp,
  configuration: BlockCommentTokenConfiguration = { canNest: true }
): [TokenType, TokenType] {
  const startCategories = [BlockCommentStart];
  const tokens: [TokenType, TokenType] = [
    createToken({
      name: "BlockCommentStart",
      label: `BlockCommentStart(${startPattern})`,
      categories: startCategories,
      pattern: makePayloadPattern(
        startPattern,
        (): BlockCommentTokenPayload => ({
          ...configuration,
          endToken: tokens[1],
        })
      ),
      line_breaks: false,
    }),
    createToken({
      name: "BlockCommentEnd",
      label: `BlockCommentEnd(${endPattern})`,
      categories: [BlockCommentEnd],
      pattern: endPattern,
      line_breaks: false,
    }),
  ];
  return tokens;
}