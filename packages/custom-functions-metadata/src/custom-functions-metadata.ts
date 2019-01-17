#!/usr/bin/env node

// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import * as fs from "fs";
import * as ts from "typescript";

export let errorLogFile = [];
export let skippedFunctions = [];

interface ICustomFunctionsMetadata {
    functions: IFunction[];
}

interface IFunction {
    name: string;
    id: string;
    helpUrl: string;
    description: string;
    parameters: IFunctionParameter[];
    result: IFunctionResult;
    options: IFunctionOptions;
}

interface IFunctionOptions {
    volatile: boolean;
    stream: boolean;
    cancelable: boolean;
}

interface IFunctionParameter {
    name: string;
    description?: string;
    type: string;
    dimensionality: string;
    optional: boolean;
}

interface IFunctionResult {
    type: string;
    dimensionality: string;
}

const CUSTOM_FUNCTION = "customfunction"; // case insensitive @CustomFunction tag to identify custom functions in JSDoc
const HELPURL_PARAM = "helpurl";
const VOLATILE = "volatile";
const STREAMING = "streaming";
const RETURN = "return";
const CANCELABLE = "cancelable";

const TYPE_MAPPINGS = {
    [ts.SyntaxKind.NumberKeyword]: "number",
    [ts.SyntaxKind.StringKeyword]: "string",
    [ts.SyntaxKind.BooleanKeyword]: "boolean",
    [ts.SyntaxKind.AnyKeyword]: "any",
    [ts.SyntaxKind.UnionType]: "any",
    [ts.SyntaxKind.TupleType]: "any",
    [ts.SyntaxKind.EnumKeyword]: "any",
    [ts.SyntaxKind.ObjectKeyword]: "any",
    [ts.SyntaxKind.VoidKeyword]: "any",
};

const TYPE_MAPPINGS_COMMENT = {
    ["number"]: 1,
    ["string"]: 2,
    ["boolean"]: 3,
    ["any"]: 4,
};

type CustomFunctionsSchemaDimensionality = "invalid" | "scalar" | "matrix";

/**
 * Check the error log and return true if any errors found
 */
export function isErrorFound(): boolean {
    return errorLogFile[0] ? true : false;
}

/**
 * Generate the metadata of the custom functions
 * @param inputFile - File that contains the custom functions
 * @param outputFileName - Name of the file to create (i.e functions.json)
 */
export async function generate(inputFile: string, outputFileName: string, noConsole?:boolean): Promise<void> {
    // @ts-ignore
    let rootObject: ICustomFunctionsMetadata = null;
    if (fs.existsSync(inputFile)) {
        
    const sourceCode = fs.readFileSync(inputFile, "utf-8");
    const sourceFile = ts.createSourceFile(inputFile, sourceCode, ts.ScriptTarget.Latest, true);

    rootObject = { functions: parseTree(sourceFile) };
    } else {
        logError("File not found: " + inputFile);
    }

    if (!isErrorFound()) {

        fs.writeFile(outputFileName, JSON.stringify(rootObject, null, 4), (err) => { if (!noConsole) {
            err ? console.error(err) : console.log(outputFileName + " created for file: " + inputFile); }
        });

        if ((skippedFunctions.length > 0) && !noConsole ) {
            console.log("The following functions were skipped.");
            skippedFunctions.forEach((func) => console.log(skippedFunctions[func]));
        }
    } else if (!noConsole) {
        console.log("Errors in file: " + inputFile);
        errorLogFile.forEach((err) => console.log(err));
    }
}

const enumList: string[] = [];

/**
 * Takes the sourcefile and attempts to parse the functions information
 * @param sourceFile source file containing the custom functions
 */
export function parseTree(sourceFile: ts.SourceFile): IFunction[] {
    const functions: IFunction[] = [];

    buildEnums(sourceFile);
    visit(sourceFile);
    return functions;

    function buildEnums(node: ts.Node) {
        if (ts.isEnumDeclaration(node)) {
            enumList.push(node.name.getText());
        }
        ts.forEachChild(node, buildEnums);
    }

    function visit(node: ts.Node) {
        if (ts.isFunctionDeclaration(node)) {
            if (node.parent && node.parent.kind === ts.SyntaxKind.SourceFile) {
                const functionDeclaration = node as ts.FunctionDeclaration;

                if (isCustomFunction(functionDeclaration)) {
                    const jsDocParamInfo = getJSDocParams(functionDeclaration);
                    const jsDocParamTypeInfo = getJSDocParamsType(functionDeclaration);
                    const jsDocsParamOptionalInfo = getJSDocParamsOptionalType(functionDeclaration);

                    const [lastParameter] = functionDeclaration.parameters.slice(-1);
                    const isStreamingFunction = isLastParameterStreaming(lastParameter);
                    const paramsToParse = isStreamingFunction
                        ? functionDeclaration.parameters.slice(0, functionDeclaration.parameters.length - 1)
                        : functionDeclaration.parameters.slice(0, functionDeclaration.parameters.length);

                    const parameters = getParameters(paramsToParse, jsDocParamTypeInfo, jsDocParamInfo, jsDocsParamOptionalInfo);

                    const description = getDescription(functionDeclaration);
                    const helpUrl = getHelpUrl(functionDeclaration);

                    const result = getResults(functionDeclaration, isStreamingFunction, lastParameter);

                    const options = getOptions(functionDeclaration, isStreamingFunction);

                    const funcName: string = (functionDeclaration.name) ? functionDeclaration.name.text : "";

                    const functionMetadata: IFunction = {
                        description,
                        helpUrl,
                        id: funcName,
                        name: funcName.toUpperCase(),
                        options,
                        parameters,
                        result,
                    };

                    if (!options.volatile && !options.stream) {
                        delete functionMetadata.options;
                    }

                    functions.push(functionMetadata);
                } else {
                    // Function was skipped
                    if (functionDeclaration.name) {
                        // @ts-ignore
                        skippedFunctions.push(functionDeclaration.name.text);
                    }
                }
            }
        }

        ts.forEachChild(node, visit);
    }
}

/**
 * Determines the options parameters for the json
 * @param func - Function
 * @param isStreamingFunction - Is is a steaming function
 */
function getOptions(func: ts.FunctionDeclaration, isStreamingFunction: boolean): IFunctionOptions {
    const optionsItem: IFunctionOptions = {
        cancelable: isStreamCancelable(func),
        stream: isStreaming(func, isStreamingFunction),
        volatile: isVolatile(func),
    };
    return optionsItem;
}

/**
 * Determines the results parameter for the json
 * @param func - Function
 * @param isStreaming - Is a streaming function
 * @param lastParameter - Last parameter of the function signature
 */
function getResults(func: ts.FunctionDeclaration, isStreamingFunction: boolean, lastParameter: ts.ParameterDeclaration): IFunctionResult {
    let resultType = "any";
    let resultDim = "scalar";
    const defaultResultItem: IFunctionResult = {
        dimensionality: resultDim,
        type: resultType,
    };

    // Try and determine the return type.  If one can't be determined we will set to any type
    if (isStreamingFunction) {
        const lastParameterType = lastParameter.type as ts.TypeReferenceNode;
        if (!lastParameterType.typeArguments || lastParameterType.typeArguments.length !== 1) {
            logError("The 'CustomFunctions.StreamingHandler' needs to be passed in a single result type (e.g., 'CustomFunctions.StreamingHandler < number >')");
            return defaultResultItem;
        }
        const returnType = func.type as ts.TypeReferenceNode;
        if (returnType && returnType.getFullText().trim() !== "void") {
            logError(`A streaming function should not have a return type.  Instead, its type should be based purely on what's inside "CustomFunctions.StreamingHandler<T>".`);
            return defaultResultItem;
        }
        resultType = getParamType(lastParameterType.typeArguments[0]);
        resultDim = getParamDim(lastParameterType.typeArguments[0]);
    } else if (func.type) {
        if (func.type.kind === ts.SyntaxKind.TypeReference &&
            (func.type as ts.TypeReferenceNode).typeName.getText() === "Promise" &&
            (func.type as ts.TypeReferenceNode).typeArguments &&
            // @ts-ignore
            (func.type as ts.TypeReferenceNode).typeArguments.length === 1
        ) {
            // @ts-ignore
            resultType = getParamType((func.type as ts.TypeReferenceNode).typeArguments[0]);
            // @ts-ignore
            resultDim = getParamDim((func.type as ts.TypeReferenceNode).typeArguments[0]);
        } else {
            resultType = getParamType(func.type);
            resultDim = getParamDim(func.type);
        }
    }

    // Check the code comments for @return parameter
    if (resultType === "any") {
        const resultFromComment = getReturnType(func);
        // @ts-ignore
        const checkType = TYPE_MAPPINGS_COMMENT[resultFromComment];
        if (!checkType) {
                logError("Unsupported type in code comment:" + resultFromComment);
            } else {
                resultType = resultFromComment;
            }
    }

    const resultItem: IFunctionResult = {
        dimensionality: resultDim,
        type: resultType,
    };

    // Only return dimensionality = matrix.  Default assumed scalar
    if (resultDim === "scalar") {
        delete resultItem.dimensionality;
    }

    return resultItem;
}

/**
 * Determines the parameter details for the json
 * @param params - Parameters
 * @param jsDocParamTypeInfo - jsDocs parameter type info
 * @param jsDocParamInfo = jsDocs parameter info
 */
function getParameters(params: ts.ParameterDeclaration[], jsDocParamTypeInfo: { [key: string]: string }, jsDocParamInfo: { [key: string]: string }, jsDocParamOptionalInfo: { [key: string]: string }): IFunctionParameter[] {
    const parameterMetadata: IFunctionParameter[] = [];
    const parameters = params
    .map((p: ts.ParameterDeclaration) => {
        const name = (p.name as ts.Identifier).text;
        let ptype = getParamType(p.type as ts.TypeNode);

        // Try setting type from parameter in code comment
        if (ptype === "any") {
            ptype = jsDocParamTypeInfo[name];
            if (ptype) {
                // @ts-ignore
                const checkType = TYPE_MAPPINGS_COMMENT[ptype.toLocaleLowerCase()];
                if (!checkType) {
                    logError("Unsupported type in code comment:" + ptype);
                }
            }
            else {
                //If type not found in comment section set to any type
                ptype = "any";
            }
        }

        const pMetadataItem: IFunctionParameter = {
            description: jsDocParamInfo[name],
            dimensionality: getParamDim(p.type as ts.TypeNode),
            name,
            optional: getParamOptional(p, jsDocParamOptionalInfo),
            type: ptype,
        };

        // Only return dimensionality = matrix.  Default assumed scalar
        if (pMetadataItem.dimensionality === "scalar") {
            delete pMetadataItem.dimensionality;
        }

        parameterMetadata.push(pMetadataItem);

    })
    .filter((meta) => meta);

    return parameterMetadata;
}

/**
 * Determines the description parameter for the json
 * @param node - jsDoc node
 */
export function getDescription(node: ts.Node): string {
    let description: string = "";
    // @ts-ignore
    if (node.jsDoc[0]) {
        // @ts-ignore
        description = node.jsDoc[0].comment;
    }
    return description;
}

/**
 * Find the tag with the specified name.
 * @param node - jsDocs node
 * @returns the tag if found; undefined otherwise.
 */
function findTag(node: ts.Node, tagName: string): ts.JSDocTag | undefined {
    return  ts.getJSDocTags(node).find((tag: ts.JSDocTag) => containsTag(tag, tagName));
}

/**
 * Determine if a node contains a tag.
 * @param node - jsDocs node
 * @returns true if the node contains the tag; false otherwise.
 */
function hasTag(node: ts.Node, tagName: string): boolean {
    return  findTag(node, tagName) !== undefined;
}

/**
 * Returns true if function is a custom function
 * @param node - jsDocs node
 */
function isCustomFunction(node: ts.Node): boolean {
    return  hasTag(node, CUSTOM_FUNCTION);
}

/**
 * Returns the @helpurl of the JSDoc
 * @param node Node
 */
function getHelpUrl(node: ts.Node): string {
    const tag = findTag(node, HELPURL_PARAM);
    return tag ? tag.comment || "" : "";
}

/**
 * Returns true if volatile tag found in comments
 * @param node jsDocs node
 */
function isVolatile(node: ts.Node): boolean {
    return hasTag(node, VOLATILE);
}

function containsTag(tag: ts.JSDocTag, tagName: string): boolean {
    return ((tag.tagName.escapedText as string).toLowerCase() === tagName);
}

/**
 * Returns true if function is streaming
 * @param node - jsDocs node
 * @param streamFunction - Is streaming function already determined by signature
 */
function isStreaming(node: ts.Node, streamFunction: boolean): boolean {
    // If streaming already determined by function signature then return true
    return streamFunction || hasTag(node, STREAMING);
}

/**
 * Returns true if streaming function is cancelable
 * @param node - jsDocs node
 */
function isStreamCancelable(node: ts.Node): boolean {
    let streamCancel = false;
    ts.getJSDocTags(node).forEach(
        (tag: ts.JSDocTag) => {
            if (containsTag(tag, STREAMING)) {
                if (tag.comment) {
                    if (tag.comment.toLowerCase() === CANCELABLE) {
                        streamCancel = true;
                    }
                }
            }
        },
    );
    return streamCancel;
}

/**
 * Returns return type of function from comments
 * @param node - jsDocs node
 */
function getReturnType(node: ts.Node): string {
    let type = "any";
    ts.getJSDocTags(node).forEach(
        (tag: ts.JSDocTag) => {
            if (containsTag(tag, RETURN)) {
                // @ts-ignore
                if (tag.typeExpression) {
                    // @ts-ignore
                    type = tag.typeExpression.getFullText().slice(1, tag.typeExpression.getFullText().length - 1).toLowerCase();
                }
            }
        },
    );
    return type;

}

/**
 * This method will parse out all of the @param tags of a JSDoc and return a dictionary
 * @param node - The function to parse the JSDoc params from
 */
function getJSDocParams(node: ts.Node): { [key: string]: string } {
    const jsDocParamInfo = {};

    ts.getAllJSDocTagsOfKind(node, ts.SyntaxKind.JSDocParameterTag).forEach(
        (tag: ts.JSDocTag) => {
            if (tag.comment) {
                const comment = (tag.comment.startsWith("-")
                    ? tag.comment.slice(1)
                    : tag.comment
                ).trim();
                // @ts-ignore
                jsDocParamInfo[(tag as ts.JSDocPropertyLikeTag).name.getFullText()] = comment;
            } else {
                // Description is missing so add empty string
                // @ts-ignore
                jsDocParamInfo[(tag as ts.JSDocPropertyLikeTag).name.getFullText()] = "";
            }
        },
    );

    return jsDocParamInfo;
}

/**
 * This method will parse out all of the @param tags of a JSDoc and return a dictionary
 * @param node - The function to parse the JSDoc params from
 */
function getJSDocParamsType(node: ts.Node): { [key: string]: string } {
    const jsDocParamTypeInfo = {};

    ts.getAllJSDocTagsOfKind(node, ts.SyntaxKind.JSDocParameterTag).forEach(
        // @ts-ignore
        (tag: ts.JSDocParameterTag) => {
            if (tag.typeExpression) {
                // Should be in the form {string}, so removing the {} around type
                const paramType = tag.typeExpression.getFullText().slice(1, tag.typeExpression.getFullText().length - 1);
                // @ts-ignore
                jsDocParamTypeInfo[(tag as ts.JSDocPropertyLikeTag).name.getFullText()] = paramType;
            } else {
                // Set as any
                // @ts-ignore
                jsDocParamTypeInfo[(tag as ts.JSDocPropertyLikeTag).name.getFullText()] = "any";
            }
        },
    );

    return jsDocParamTypeInfo;
}

/**
 * This method will parse out all of the @param tags of a JSDoc and return a dictionary
 * @param node - The function to parse the JSDoc params from
 */
function getJSDocParamsOptionalType(node: ts.Node): { [key: string]: string } {
    const jsDocParamOptionalTypeInfo = {};

    ts.getAllJSDocTagsOfKind(node, ts.SyntaxKind.JSDocParameterTag).forEach(
        // @ts-ignore
        (tag: ts.JSDocParameterTag) => {
            // @ts-ignore
            jsDocParamOptionalTypeInfo[(tag as ts.JSDocPropertyLikeTag).name.getFullText()] = tag.isBracketed;
        },
    );

    return jsDocParamOptionalTypeInfo;
}

/**
 * Determines if the last parameter is streaming
 * @param param ParameterDeclaration
 */
function isLastParameterStreaming(param: ts.ParameterDeclaration): boolean {
    const isTypeReferenceNode = param && param.type && ts.isTypeReferenceNode(param.type);
    if (!isTypeReferenceNode) {
        return false;
    }

    const typeRef = param.type as ts.TypeReferenceNode;
    return (
        typeRef.typeName.getText() === "CustomFunctions.StreamingHandler" ||
        typeRef.typeName.getText() === "IStreamingCustomFunctionHandler" /* older version*/
    );
}

/**
 * Gets the parameter type of the node
 * @param t TypeNode
 */
function getParamType(t: ts.TypeNode): string {
    let type = "any";
    // Only get type for typescript files.  js files will return any for all types
    if (t) {
        let kind = t.kind;
        if (ts.isTypeReferenceNode(t)) {
            const arrTr = t as ts.TypeReferenceNode;
            if (enumList.indexOf(arrTr.typeName.getText()) >= 0) {
                // Type found in the enumList
                return type;
            }
            if (arrTr.typeName.getText() !== "Array") {
                logError("Invalid type: " + arrTr.typeName.getText());
                return type;
            }
            if (arrTr.typeArguments) {
            const isArrayWithTypeRefWithin = validateArray(t) && ts.isTypeReferenceNode(arrTr.typeArguments[0]);
            if (isArrayWithTypeRefWithin) {
                    const inner = arrTr.typeArguments[0] as ts.TypeReferenceNode;
                    if (!validateArray(inner)) {
                        logError("Invalid type array: " + inner.getText());
                        return type;
                    }
                    if (inner.typeArguments) {
                        kind = inner.typeArguments[0].kind;
                    }
                }
            }
        } else if (ts.isArrayTypeNode(t)) {
            const inner = (t as ts.ArrayTypeNode).elementType;
            if (!ts.isArrayTypeNode(inner)) {
                logError("Invalid array type node: " + inner.getText());
                return type;
            }
            // Expectation is that at this point, "kind" is a primitive type (not 3D array).
            // However, if not, the TYPE_MAPPINGS check below will fail.
            kind = inner.elementType.kind;
        }
        // @ts-ignore
        type = TYPE_MAPPINGS[kind];
        if (!type) {
            logError("Type doesn't match mappings");
        }
    }
    return type;
}

/**
 * Get the parameter dimensionality of the node
 * @param t TypeNode
 */
function getParamDim(t: ts.TypeNode): string {
    let dimensionality: CustomFunctionsSchemaDimensionality = "scalar";
    if (t) {
        if (ts.isTypeReferenceNode(t) || ts.isArrayTypeNode(t)) {
            dimensionality = "matrix";
        }
    }
    return dimensionality;
}

function getParamOptional(p: ts.ParameterDeclaration, jsDocParamOptionalInfo: { [key: string]: string }): boolean {
    let optional = false;
    const name = (p.name as ts.Identifier).text;
    const isOptional = p.questionToken != null || p.initializer != null || p.dotDotDotToken != null;
    // If parameter is found to be optional in ts
    if (isOptional) {
        optional = true;
    // Else check the comments section for [name] format
    } else {
        // @ts-ignore
        optional = jsDocParamOptionalInfo[name];
    }
    return optional;
}

/**
 * This function will return `true` for `Array<[object]>` and `false` otherwise.
 * @param a - TypeReferenceNode
 */
function validateArray(a: ts.TypeReferenceNode) {
    return (
        a.typeName.getText() === "Array" && a.typeArguments && a.typeArguments.length === 1
    );
}

/**
 * Log containing all the errors found while parsing
 * @param error Error string to add to the log
 */
export function logError(error: string) {
    // @ts-ignore
    errorLogFile.push(error);
}
