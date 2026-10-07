import * as vscode from 'vscode';
import type { Middleware } from 'vscode-languageclient/node';

function getOriginSelectionRange(
    document: vscode.TextDocument,
    position: vscode.Position,
): vscode.Range | undefined {
    const line = document.lineAt(position.line).text;
    const importedPath = /^(\s*import(?:\s+(?:public|weak))?\s+)(["'])([^"'\r\n]+)\2\s*;/.exec(line);
    if (importedPath) {
        const start = importedPath[1].length + 1;
        const end = start + importedPath[3].length;
        if (position.character < start || position.character >= end) {
            return undefined;
        }
        return new vscode.Range(position.line, start, position.line, end);
    }

    // Include the package and optional leading dot, but not the field name.
    return document.getWordRangeAtPosition(
        position,
        /\.?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+/,
    );
}

export const navigationMiddleware: Middleware = {
    async provideDefinition(document, position, token, next) {
        const result = await next(document, position, token);
        if (token.isCancellationRequested) {
            return undefined;
        }
        if (!result) {
            return result;
        }

        const originSelectionRange = getOriginSelectionRange(document, position);
        if (!originSelectionRange) {
            return result;
        }

        // Protols returns Locations without a source range. Otherwise VS Code
        // underlines only the word under the pointer, splitting paths and types.
        const locations = Array.isArray(result) ? result : [result];
        return locations.map(location => {
            if ('targetUri' in location) {
                return {
                    ...location,
                    originSelectionRange: location.originSelectionRange ?? originSelectionRange,
                };
            }
            return {
                originSelectionRange,
                targetUri: location.uri,
                targetRange: location.range,
                targetSelectionRange: location.range,
            };
        });
    },

    async provideReferences(document, position, context, token, next) {
        const references = await next(document, position, context, token);
        if (token.isCancellationRequested) {
            return undefined;
        }
        if (!references?.length || context.includeDeclaration) {
            return references;
        }

        // Protols 0.14.1 ignores includeDeclaration=false. VS Code asks for
        // declaration-free references before deciding whether to skip Peek
        // and navigate directly to a single actual use.
        let definitions: (vscode.Location | vscode.LocationLink)[] | undefined;
        try {
            definitions = await vscode.commands.executeCommand(
                'vscode.executeDefinitionProvider', document.uri, position,
            );
        } catch {
            return token.isCancellationRequested ? undefined : references;
        }
        if (token.isCancellationRequested) {
            return undefined;
        }
        if (!definitions?.length) {
            return references;
        }

        return references.filter(reference => !definitions.some(definition => {
            const uri = 'targetUri' in definition ? definition.targetUri : definition.uri;
            const range = 'targetUri' in definition
                ? definition.targetSelectionRange ?? definition.targetRange
                : definition.range;
            return reference.uri.toString() === uri.toString() && reference.range.isEqual(range);
        }));
    },
};
