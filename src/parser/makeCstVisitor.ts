import { CstNode, IToken } from "chevrotain";
import { strict as assert } from "assert";
import {
  COMMAND_END_PATTERN,
  COMMAND_PATTERN,
  COMMAND_START_PATTERN,
} from "../lexer/tokens";
import { RootParser } from "./RootParser";
import { jsonErrorToVisitorError } from "./jsonErrorToVisitorError";
import { innerLocationToOuterLocation } from "./innerOffsetToOuterLocation";
import { PushParserTokenPayload } from "../lexer/makePushParserTokens";

// See https://sap.github.io/chevrotain/docs/tutorial/step3a_adding_actions$visitor.html

export interface Location {
  line: number;
  column: number;
  offset: number;
}

export interface Range {
  start: Location;
  end: Location;
}

function locationFromToken(token: IToken): Location {
  return {
    line: token.startLine,
    column: token.startColumn,
    offset: token.startOffset,
  };
}

function locationAfterToken(token: IToken, fullText: string): Location {
  const location = {
    line: token.endLine,
    column: token.endColumn,
    offset: token.endOffset,
  };
  // Ensure the line/column are correctly rolled over if the character is
  // actually a newline
  if (/\r|\n/.test(fullText[location.offset])) {
    location.column = 1;
    location.line += 1;
  }
  return location;
}

export interface VisitorError {
  message: string;
  location: Location;
}

export interface VisitorResult {
  errors: VisitorError[];
  commands: CommandNode[];
}

type CommandNodeContext =
  | "none"
  | "stringLiteral"
  | "lineComment"
  | "blockComment";

export class CommandNode {
  commandName: string;
  get inContext(): CommandNodeContext {
    return this._context[this._context.length - 1] || "none";
  }

  _context = Array<CommandNodeContext>();

  // ranges covered by this node
  range: Range;
  contentRange?: Range;

  // Only available in block commands:
  get id(): string | undefined {
    return this.attributes?.id;
  }
  children?: CommandNode[];

  // Attributes come from JSON and their schema depends on the command.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  attributes?: { [member: string]: any };

  // Block Commands operate on their inner range and can have children, IDs, and
  // attributes.
  makeChildBlockCommand(commandName: string): CommandNode {
    assert(this.children);
    const command = new CommandNode(commandName, this);
    command.children = [];
    return command;
  }

  // Line Commands operate on the line they appear in and cannot have children,
  // IDs, or attributes.
  makeChildLineCommand(commandName: string): CommandNode {
    assert(this.children);
    return new CommandNode(commandName, this);
  }

  withErasedBlockCommand(
    callback: (erasedBlockCommand: CommandNode) => void
  ): void {
    assert(this.children);
    // We erase whatever element created the context and add what would have
    // been that element's children to the parent node. This is definitely
    // weird, but only used internally...
    const node = new CommandNode(
      "__this_should_not_be_here___please_file_a_bug__"
    );
    node.children = [];
    callback(node);
    this.children = [...this.children, ...node.children];
  }

  // The root command is the root node of a parsed document and contains all
  // other nodes in the document.
  static rootCommand(): CommandNode {
    const command = new CommandNode("__root__");
    command.attributes = new Map();
    command.children = [];
    return command;
  }

  private constructor(commandName: string, parentToAttachTo?: CommandNode) {
    this.commandName = commandName;
    if (parentToAttachTo != null) {
      this._context = [...parentToAttachTo._context];
      parentToAttachTo.children.push(this);
    }
  }
}

export interface IVisitor {
  parser: RootParser;
  visit(node: CstNode): VisitorResult;
}

// While the lexer defines the tokens (words) and the parser defines the syntax,
// the CstVisitor defines the semantics of the language.
export function makeCstVisitor(parser: RootParser): IVisitor {
  // The following context interfaces (should) match the corresponding parser
  // rule. Subrules appear as CstNode[]. Tokens appear as IToken[]. If the
  // element is optional in the syntax, it's TypeScript optional™ in the context
  // interface.

  // For whatever reason, chevrotain always provides *arrays* of CstNodes and
  // ITokens, even if you know there can only be one.
  interface AnnotatedTextContext {
    chunk?: CstNode[];
  }

  interface AttributeListContext {
    AttributeListStart: IToken[];
    AttributeListEnd: IToken[];
    LineComment: IToken[];
  }

  interface BlockCommandContext {
    CommandStart: IToken[];
    commandAttribute?: CstNode[];
    Newline: IToken[];
    chunk: CstNode[];
    CommandEnd: IToken[];
  }

  interface BlockCommentContext {
    BlockCommentStart: IToken[];
    command?: CstNode[];
    LineComment?: IToken[];
    Newline?: IToken[];
    blockComment?: CstNode[];
    BlockCommentEnd: IToken[];
  }

  interface ChunkContext {
    blockComment?: CstNode[];
    command?: CstNode[];
    lineComment?: CstNode[];
    pushParser?: CstNode[];
    Newline: IToken[];
  }

  interface CommandContext {
    Command?: IToken[];
    blockCommand?: CstNode[];
  }

  interface CommandAttributeContext {
    Identifier?: IToken[];
    attributeList?: CstNode[];
  }

  interface LineCommentContext {
    LineComment: IToken[];
    command?: CstNode[];
    BlockCommentStart?: IToken[];
    BlockCommentEnd?: IToken[];
  }

  interface PushParserContext {
    PushParser: IToken[];
    PopParser: IToken[];
  }

  interface StringLiteralContext {
    StringLiteralStart: IToken[];
    pushParser: CstNode[];
    Newline: IToken[];
    StringLiteralEnd: IToken[];
  }

  // Tuple passed to visitor methods. All errors go to the top level. Visitor
  // methods operate on the parent node, usually by adding child nodes to the
  // parent.
  interface VA {
    parent: CommandNode;
    errors: VisitorError[];
  }

  return new (class CstVisitor extends parser.getBaseCstVisitorConstructor() {
    parser = parser;

    constructor() {
      super();
      // The "validateVisitor" method is a helper utility which performs static analysis
      // to detect missing or redundant visitor methods
      this.validateVisitor();
    }

    // The entrypoint for the visitor.
    visit(node: CstNode): VisitorResult {
      const parent = CommandNode.rootCommand();
      const errors = [];
      this.$visit([node], { errors, parent });
      return {
        errors,
        commands: parent.children,
      };
    }

    // chevrotain requires helper methods to begin with a token other than
    // [0-9A-z-_] which leaves... $?
    private $visit(nodes: CstNode[] | undefined, { parent, errors }: VA) {
      assert(parent != null);
      if (nodes) {
        nodes.forEach((node) => super.visit(node, { parent, errors }));
      }
    }

    annotatedText(context: AnnotatedTextContext, { parent, errors }: VA) {
      assert(parent != null);
      // Flatten annotatedText and chunks to one list ordered by appearance in
      // the file and allow each chunk to add to the parent's child list.
      this.$visit(
        (context.chunk ?? []).sort(
          (a, b) => a.location.startOffset - b.location.startOffset
        ),
        { parent, errors }
      );
    }

    attributeList(context: AttributeListContext, { parent, errors }: VA) {
      // ⚠️ This should not recursively visit inner attributeLists
      assert(parent != null);
      const AttributeListStart = context.AttributeListStart[0];
      const AttributeListEnd = context.AttributeListEnd[0];
      assert(AttributeListStart);
      assert(AttributeListEnd);

      // Retrieve the full text document as the custom payload from the token.
      // Note that AttributeListStart was created with a custom pattern that
      // stores the full text document in the custom payload.
      const { payload } = AttributeListStart;
      const { fullText } = payload as PushParserTokenPayload;
      assert(
        fullText,
        "Unexpected empty payload in AttributeListStart! This is a bug in the parser. Please submit a bug report containing the document that caused this assertion failure."
      );

      // Reminder: substr(startOffset, length) vs. substring(startOffset, endOffset)
      let json = fullText.substring(
        AttributeListStart.startOffset,
        AttributeListEnd.endOffset + 1
      );

      // There may be line comments to strip out
      if (context.LineComment) {
        context.LineComment.forEach((LineComment) => {
          // Make offsets relative to the JSON string, not the overall document
          const startOffset =
            LineComment.startOffset - AttributeListStart.startOffset;
          const endOffset =
            LineComment.endOffset - AttributeListStart.startOffset; // [sic]
          // Replace line comments with harmless spaces
          json =
            json.substring(0, startOffset) +
            " ".repeat(LineComment.image.length) +
            json.substring(endOffset + 1);
        });
      }

      try {
        const object = JSON.parse(json);
        // The following should be impossible in the parser.
        assert(
          typeof object === "object" && object !== null,
          "attributeList is not an object. This is a bug in the parser. Please submit a bug report containing the document that caused this assertion failure."
        );
        parent.attributes = object;
      } catch (error) {
        errors.push(
          jsonErrorToVisitorError(error, json, {
            line: AttributeListStart.startLine,
            column: AttributeListStart.startColumn,
            offset: AttributeListStart.startOffset,
          })
        );
      }
    }

    blockCommand(context: BlockCommandContext, { parent, errors }: VA) {
      assert(parent != null);

      // Extract the command name ("example") from the
      // ":example-start:"/":example-end:" tokens
      const commandName = COMMAND_START_PATTERN.exec(
        context.CommandStart[0].image
      )[1];
      assert(commandName);

      const newNode = parent.makeChildBlockCommand(commandName);

      newNode.range = {
        start: {
          line: context.CommandStart[0].startLine,
          column: context.CommandStart[0].startColumn,
          offset: context.CommandStart[0].startOffset,
        },
        end: {
          line: context.CommandEnd[0].endLine,
          column: context.CommandEnd[0].endColumn,
          offset: context.CommandEnd[0].endOffset,
        },
      };

      if (context.chunk != undefined) {
        newNode.contentRange = {
          start: {
            line: context.Newline[0].endLine + 1,
            column: 1,
            offset: context.Newline[0].endOffset + 1,
          },
          end: {
            line: context.CommandEnd[0].startLine,
            column: context.CommandEnd[0].startColumn - 1,
            offset: context.CommandEnd[0].startOffset - 1,
          },
        };
      }

      const endCommandName = COMMAND_END_PATTERN.exec(
        context.CommandEnd[0].image
      )[1];

      // Compare start/end name to ensure it is the same command
      if (newNode.commandName !== endCommandName) {
        errors.push({
          location: locationFromToken(context.CommandEnd[0]),
          message: `Unexpected ${endCommandName}-end closing ${newNode.commandName}-start`,
        });
      }

      this.$visit(context.commandAttribute, { parent: newNode, errors });
      this.$visit(context.chunk, { parent: newNode, errors });
    }

    blockComment(context: BlockCommentContext, { parent, errors }: VA) {
      assert(parent != null);
      // This node (blockComment) should not be included in the final output. We
      // use it to gather child nodes and attach them to the parent node.
      parent.withErasedBlockCommand((erasedBlockCommand) => {
        erasedBlockCommand._context.push("blockComment");
        this.$visit(
          [...(context.blockComment ?? []), ...(context.command ?? [])],
          { parent: erasedBlockCommand, errors }
        );
      });
    }

    chunk(context: ChunkContext, { parent, errors }: VA) {
      assert(parent != null);
      // Like annotatedText, merge all child nodes into a list of children
      // attached to the parent node, ordered by their appearance in the
      // document.
      this.$visit(
        [
          ...(context.blockComment ?? []),
          ...(context.command ?? []),
          ...(context.lineComment ?? []),
          ...(context.pushParser ?? []),
        ].sort((a, b) => a.location.startOffset - b.location.startOffset),
        { parent, errors }
      );
    }

    command(context: CommandContext, { parent, errors }: VA) {
      assert(parent != null);
      if (context.blockCommand) {
        assert(!context.Command); // Parser issue!
        this.$visit(context.blockCommand, { parent, errors });
        return;
      }
      assert(context.Command);

      context.Command.forEach((Command) => {
        const newNode = parent.makeChildLineCommand(
          COMMAND_PATTERN.exec(Command.image)[1]
        );
        newNode.range = {
          start: {
            line: Command.startLine,
            column: Command.startColumn,
            offset: Command.startOffset,
          },
          end: {
            line: Command.endLine,
            column: Command.endColumn,
            offset: Command.endOffset,
          },
        };
      });
    }

    commandAttribute(context: CommandAttributeContext, { parent, errors }: VA) {
      assert(parent != null);
      const Identifier = context.Identifier;
      const attributeList = context.attributeList;
      if (Identifier != undefined) {
        assert(!attributeList); // parser issue
        assert(Identifier[0].image.length > 0);
        parent.attributes = { id: Identifier[0].image };
      } else if (context.attributeList != undefined) {
        assert(!Identifier); // parser issue
        assert(attributeList.length === 1); // should be impossible to have more than 1 list
        this.$visit(attributeList, { parent, errors });
      }
    }

    lineComment(context: LineCommentContext, { parent, errors }: VA) {
      assert(parent != null);
      const { command } = context;
      if (command === undefined) {
        return;
      }
      parent.withErasedBlockCommand((erasedBlockCommand) => {
        // Any blockCommand that starts in a lineComment by definition MUST be
        // on the same line as the line comment
        erasedBlockCommand._context.push("lineComment");
        this.$visit(command, { parent: erasedBlockCommand, errors });
      });
    }

    pushParser(context: PushParserContext, { parent, errors }: VA) {
      // ⚠️ This should not recursively visit inner pushParsers
      assert(parent != null);
      const PushParser = context.PushParser[0];
      const PopParser = context.PopParser[0];
      assert(PushParser);
      assert(PopParser);

      // Retrieve the full text document as the custom payload from the token.
      // Note that AttributeListStart was created with a custom pattern that
      // stores the full text document in the custom payload.
      const { payload } = PushParser;
      const {
        fullText,
        getInnerVisitor,
        includeTokens,
        endToken,
      } = payload as PushParserTokenPayload;

      assert(
        fullText,
        "Unexpected empty payload in AttributeListStart! This is a bug in the parser. Please submit a bug report containing the document that caused this assertion failure."
      );

      const startLocation = includeTokens
        ? locationFromToken(PushParser)
        : locationAfterToken(PushParser, fullText);

      // Reminder: substr(startOffset, length) vs. substring(startOffset, endOffset)
      const substring = fullText.substring(
        startLocation.offset,
        includeTokens ? PopParser.endOffset + 1 : PopParser.startOffset
      );

      const visitor = getInnerVisitor(this);
      assert(visitor); // Did you provide the alternate parser?
      const { parser } = visitor;
      const parseResult = parser.parse(substring);
      parseResult.errors.forEach((error) =>
        errors.push({
          ...error,
          location: innerLocationToOuterLocation(
            error.location,
            substring,
            startLocation
          ),
        })
      );

      if (!parseResult.cst) {
        errors.push({
          location: locationFromToken(PushParser),
          message: `Failed to parse subsection with alternate parser`,
        });
        return;
      }
      const result = visitor.visit(parseResult.cst);
      parent.children = [...parent.children, ...result.commands];
      result.errors.forEach((error) =>
        errors.push({
          ...error,
          location: innerLocationToOuterLocation(
            error.location,
            substring,
            startLocation
          ),
        })
      );
    }

    dummyPushParser() {
      // This method is required, but should never be called.
      assert(false);
    }

    stringLiteral(context: StringLiteralContext, params: VA) {
      this.$visit(context.pushParser, params);
    }
  })();
}
