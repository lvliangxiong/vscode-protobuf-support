import * as assert from 'assert';
import * as vscode from 'vscode';
import { navigationMiddleware } from '../protols/navigation';

suite('Proto navigation', () => {
    let cancellation: vscode.CancellationTokenSource;
    const disposables: vscode.Disposable[] = [];
    const target = new vscode.Location(vscode.Uri.file('/navigation/shared.proto'), new vscode.Range(3, 8, 3, 20));

    setup(() => {
        cancellation = new vscode.CancellationTokenSource();
    });

    teardown(() => {
        cancellation.dispose();
        disposables.splice(0).forEach(disposable => disposable.dispose());
    });

    function openDocument(content: string) {
        // Plain text avoids activating the extension or downloading Protols.
        return vscode.workspace.openTextDocument({ content, language: 'plaintext' });
    }

    async function definition(
        document: vscode.TextDocument,
        character: number,
        result: vscode.Definition | vscode.DefinitionLink[] | undefined = target,
    ) {
        return navigationMiddleware.provideDefinition!(
            document, new vscode.Position(0, character), cancellation.token, () => result,
        );
    }

    function assertLink(result: vscode.Definition | vscode.DefinitionLink[] | null | undefined, expected: string, document: vscode.TextDocument) {
        assert.ok(Array.isArray(result));
        assert.strictEqual(result.length, 1);
        const link = result[0] as vscode.DefinitionLink;
        assert.ok(link.originSelectionRange);
        assert.strictEqual(document.getText(link.originSelectionRange), expected);
        assert.strictEqual(link.targetUri.toString(), target.uri.toString());
        assert.ok(link.targetRange.isEqual(target.range));
        assert.ok(link.targetSelectionRange?.isEqual(target.range));
    }

    for (const statement of [
        'import "api/example/shared.proto";',
        '  import public "api/example/shared.proto";',
        "\timport weak 'api/example/shared.proto';",
    ]) {
        test(`links the entire path in ${statement.trim()}`, async () => {
            const document = await openDocument(statement);
            for (const part of ['api', 'example', 'shared', '.proto']) {
                assertLink(await definition(document, statement.indexOf(part) + 1), 'api/example/shared.proto', document);
            }
            // Neither the quotes nor the import keyword are part of the link.
            assert.strictEqual(await definition(document, statement.indexOf('import')), target);
            assert.strictEqual(await definition(document, statement.indexOf('api') - 1), target);
            assert.strictEqual(await definition(document, statement.indexOf(';') - 1), target);
        });
    }

    for (const type of ['example.api.CommonHeader', '.example.api.CommonHeader']) {
        test(`links the whole qualified type ${type}`, async () => {
            const statement = `${type} CommonHeader = 1;`;
            const document = await openDocument(statement);
            for (let character = 0; character < type.length; character++) {
                assertLink(await definition(document, character), type, document);
            }
            assert.strictEqual(await definition(document, statement.lastIndexOf('CommonHeader') + 1), target);
        });
    }

    test('converts every Location and preserves target ranges', async () => {
        const document = await openDocument('example.api.Request request = 1;');
        const other = new vscode.Location(target.uri, new vscode.Range(9, 8, 9, 15));
        const result = await definition(document, 2, [target, other]) as vscode.DefinitionLink[];
        assert.strictEqual(result.length, 2);
        assert.ok(result[1].targetSelectionRange?.isEqual(other.range));
        assert.strictEqual(document.getText(result[1].originSelectionRange), 'example.api.Request');
    });

    test('preserves explicit server-provided link ranges', async () => {
        const document = await openDocument('example.api.Request request = 1;');
        const link: vscode.DefinitionLink = {
            originSelectionRange: new vscode.Range(0, 12, 0, 19),
            targetUri: target.uri,
            targetRange: new vscode.Range(3, 0, 8, 1),
            targetSelectionRange: target.range,
        };
        assert.deepStrictEqual(await definition(document, 14, [link]), [link]);
        const { originSelectionRange, ...withoutOrigin } = link;
        const result = await definition(document, 14, [withoutOrigin]) as vscode.DefinitionLink[];
        assert.strictEqual(document.getText(result[0].originSelectionRange), 'example.api.Request');
        assert.ok(result[0].targetRange.isEqual(link.targetRange));
    });

    test('leaves ordinary identifiers and empty definition results unchanged', async () => {
        const document = await openDocument('Request request = 1;');
        assert.strictEqual(await definition(document, 2), target);
        assert.deepStrictEqual(await definition(document, 2, []), []);
        assert.strictEqual(await navigationMiddleware.provideDefinition!(
            document, new vscode.Position(0, 2), cancellation.token, () => undefined,
        ), undefined);
    });

    async function referenceFixture() {
        const document = await openDocument('message Request {}\nRequest first = 1;\nRequest second = 2;');
        const declaration = new vscode.Location(document.uri, new vscode.Range(0, 8, 0, 15));
        const first = new vscode.Location(document.uri, new vscode.Range(1, 0, 1, 7));
        const second = new vscode.Location(document.uri, new vscode.Range(2, 0, 2, 7));
        return { document, declaration, first, second };
    }

    function registerDefinition(document: vscode.TextDocument, result: vscode.Definition | vscode.DefinitionLink[] | undefined) {
        let calls = 0;
        disposables.push(vscode.languages.registerDefinitionProvider('plaintext', {
            provideDefinition(candidate) {
                if (candidate.uri.toString() !== document.uri.toString()) {
                    return undefined;
                }
                calls++;
                return result;
            },
        }));
        return () => calls;
    }

    async function references(document: vscode.TextDocument, results: vscode.Location[] | undefined, includeDeclaration = false) {
        const context = { includeDeclaration };
        return navigationMiddleware.provideReferences!(
            document, new vscode.Position(0, 10), context, cancellation.token,
            (receivedDocument, position, receivedContext, token) => {
                assert.strictEqual(receivedDocument, document);
                assert.ok(position.isEqual(new vscode.Position(0, 10)));
                assert.strictEqual(receivedContext, context);
                assert.strictEqual(token, cancellation.token);
                return results;
            },
        );
    }

    test('returns one actual use for VS Code single-reference navigation', async () => {
        const { document, declaration, first } = await referenceFixture();
        registerDefinition(document, declaration);
        assert.deepStrictEqual(await references(document, [declaration, first]), [first]);
    });

    test('preserves multiple uses and honors requests to include declarations', async () => {
        const { document, declaration, first, second } = await referenceFixture();
        const calls = registerDefinition(document, declaration);
        const all = [declaration, first, second];
        assert.strictEqual(await references(document, all, true), all);
        assert.strictEqual(calls(), 0);
        assert.deepStrictEqual(await references(document, all), [first, second]);
    });

    test('matches a declaration by URI and selection range, not its enclosing range', async () => {
        const { document, declaration, first } = await referenceFixture();
        registerDefinition(document, [{
            targetUri: declaration.uri,
            targetRange: new vscode.Range(0, 0, 0, 18),
            targetSelectionRange: declaration.range,
        }]);
        const otherFile = new vscode.Location(target.uri, declaration.range);
        assert.deepStrictEqual(await references(document, [declaration, first, otherFile]), [first, otherFile]);
    });

    test('supports servers that already exclude declarations', async () => {
        const { document, declaration, first } = await referenceFixture();
        registerDefinition(document, declaration);
        assert.deepStrictEqual(await references(document, [first]), [first]);
        assert.deepStrictEqual(await references(document, [declaration]), []);
    });

    test('supports definition links without an optional selection range', async () => {
        const { document, declaration, first } = await referenceFixture();
        registerDefinition(document, [{ targetUri: declaration.uri, targetRange: declaration.range }]);
        assert.deepStrictEqual(await references(document, [declaration, first]), [first]);
    });

    test('preserves references if the definition cannot be resolved', async () => {
        const { document, declaration, first } = await referenceFixture();
        registerDefinition(document, undefined);
        const all = [declaration, first];
        assert.strictEqual(await references(document, all), all);
    });

    test('does not look up definitions for empty results or cancelled requests', async () => {
        const { document, declaration } = await referenceFixture();
        const calls = registerDefinition(document, declaration);
        assert.deepStrictEqual(await references(document, []), []);
        assert.strictEqual(await references(document, undefined), undefined);
        cancellation.cancel();
        assert.strictEqual(await references(document, [declaration]), undefined);
        assert.strictEqual(await definition(document, 10), undefined);
        assert.strictEqual(calls(), 0);
    });
});
