// Copyright (c) .NET Foundation and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

import * as fs from 'fs';
import * as vscode from 'vscode';
import * as path from 'path';
import { ClientMapper } from '../clientMapper';

import { StdioKernelTransport } from '../stdioKernelTransport';
import { registerLanguageProviders } from './languageProvider';
import { registerAcquisitionCommands, registerKernelCommands, registerFileCommands } from './commands';

import { getSimpleLanguage, isDotnetInteractiveLanguage } from '../interactiveNotebook';
import { InteractiveLaunchOptions, InstallInteractiveArgs } from '../interfaces';

import { executeSafe, isDotnetKernel, isDotNetUpToDate, processArguments } from '../utilities';
import { OutputChannelAdapter } from './OutputChannelAdapter';

import * as jupyter from './jupyter';
import * as versionSpecificFunctions from '../../versionSpecificFunctions';

import { isInsidersBuild, isStableBuild } from './vscodeUtilities';

export const KernelId = 'dotnet-interactive';

export class CachedDotNetPathManager {
    private dotNetPath: string = 'dotnet'; // default to global tool if possible
    private outputChannelAdapter: OutputChannelAdapter | undefined = undefined;

    getDotNetPath(): string {
        return this.dotNetPath;
    }

    setDotNetPath(dotNetPath: string) {
        if (this.dotNetPath !== dotNetPath) {
            this.dotNetPath = dotNetPath;
            if (this.outputChannelAdapter) {
                this.outputChannelAdapter.appendLine(`dotnet path set to '${this.dotNetPath}'`);
            }
        }
    }

    setOutputChannelAdapter(outputChannelAdapter: OutputChannelAdapter) {
        this.outputChannelAdapter = outputChannelAdapter;
    }
}

export const DotNetPathManager = new CachedDotNetPathManager();

export async function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('dotnet-interactive');
    const minDotNetSdkVersion = config.get<string>('minimumDotNetSdkVersion') || '5.0';
    const diagnosticsChannel = new OutputChannelAdapter(vscode.window.createOutputChannel('.NET Interactive : diagnostics'));
    DotNetPathManager.setOutputChannelAdapter(diagnosticsChannel);

    // pause if an sdk installation is currently running
    await waitForSdkInstall(minDotNetSdkVersion);

    // this must happen early, because some following functions use the acquisition command
    registerAcquisitionCommands(context, diagnosticsChannel);

    vscode.window.registerUriHandler({
        handleUri(uri: vscode.Uri): vscode.ProviderResult<void> {
            switch (uri.path) {
                case '/newNotebook':
                    vscode.commands.executeCommand('dotnet-interactive.acquire').then(() => {
                        vscode.commands.executeCommand('dotnet-interactive.newNotebook').then(() => { });
                    });
                    break;
                case '/openNotebook':
                    const params = new URLSearchParams(uri.query);
                    const path = params.get('path');
                    if (path) {
                        vscode.commands.executeCommand('dotnet-interactive.acquire').then(() => {
                            vscode.commands.executeCommand('dotnet-interactive.openNotebook', vscode.Uri.file(path)).then(() => { });
                        });
                    }
                    break;
            }
        }
    });

    // register with VS Code
    const clientMapper = new ClientMapper(async (notebookPath) => {
        if (!await checkForDotNetSdk(minDotNetSdkVersion!)) {
            const message = 'Unable to find appropriate .NET SDK.';
            vscode.window.showErrorMessage(message);
            throw new Error(message);
        }

        const launchOptions = await getInteractiveLaunchOptions();
        if (!launchOptions) {
            throw new Error(`Unable to get interactive launch options.  Please see the '${diagnosticsChannel.getName()}' output window for details.`);
        }

        // prepare kernel transport launch arguments and working directory using a fresh config item so we don't get cached values

        const kernelTransportArgs = config.get<Array<string>>('kernelTransportArgs')!;
        const argsTemplate = {
            args: kernelTransportArgs,
            workingDirectory: config.get<string>('kernelTransportWorkingDirectory')!
        };

        // ensure a reasonable working directory is selected
        const fallbackWorkingDirectory = (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0)
            ? vscode.workspace.workspaceFolders[0].uri.fsPath
            : '.';

        const processStart = processArguments(argsTemplate, notebookPath, fallbackWorkingDirectory, DotNetPathManager.getDotNetPath(), launchOptions!.workingDirectory);
        let notification = {
            displayError: async (message: string) => { await vscode.window.showErrorMessage(message, { modal: false }); },
            displayInfo: async (message: string) => { await vscode.window.showInformationMessage(message, { modal: false }); },
        };
        const transport = new StdioKernelTransport(notebookPath, processStart, diagnosticsChannel, vscode.Uri.parse, notification, (pid, code, signal) => {
            clientMapper.closeClient({ fsPath: notebookPath }, false);
        });
        await transport.waitForReady();

        let externalUri = await vscode.env.asExternalUri(vscode.Uri.parse(`http://localhost:${transport.httpPort}`));
        //create tunnel for teh kernel transport
        await transport.setExternalUri(externalUri);

        return transport;
    }, diagnosticsChannel);

    registerKernelCommands(context, clientMapper);

    const hostVersionSuffix = isInsidersBuild() ? 'Insiders' : 'Stable';
    diagnosticsChannel.appendLine(`Extension started for VS Code ${hostVersionSuffix}.`);

    const jupyterExtension = vscode.extensions.getExtension('ms-toolsai.jupyter');

    // Default to using the Jupyter extension for .ipynb handling if the extension is present, unless the user has
    // specified otherwise.
    const jupyterExtensionIsPresent = jupyterExtension !== undefined;
    let useJupyterExtension = jupyterExtensionIsPresent;
    const forceDotNetIpynbHandling = config.get<boolean>('useDotNetInteractiveExtensionForIpynbFiles') || false;
    if (forceDotNetIpynbHandling && isStableBuild()) {
        useJupyterExtension = false;
    }

    let jupyterApi: jupyter.IJupyterExtensionApi | undefined = undefined;
    if (useJupyterExtension) {
        try {
            jupyterApi = <jupyter.IJupyterExtensionApi>await jupyterExtension!.activate();
            jupyterApi.registerNewNotebookContent({ defaultCellLanguage: 'dotnet-interactive.csharp' });
        } catch (err) {
            diagnosticsChannel.appendLine(`Error activating and registering with Jupyter extension: ${err}.  Defaulting to local file handling.`);
            useJupyterExtension = false;
            jupyterApi = undefined;
        }
    }

    const languageServiceDelay = config.get<number>('languageServiceDelay') || 500; // fall back to something reasonable

    // notebook kernels
    const apiBootstrapperUri = vscode.Uri.file(path.join(context.extensionPath, 'resources', 'kernelHttpApiBootstrapper.js'));
    if (!fs.existsSync(apiBootstrapperUri.fsPath)) {
        throw new Error(`Unable to find bootstrapper API expected at '${apiBootstrapperUri.fsPath}'.`);
    }

    versionSpecificFunctions.registerWithVsCode(context, clientMapper, diagnosticsChannel, useJupyterExtension, apiBootstrapperUri);

    registerFileCommands(context, clientMapper, jupyterApi);

    context.subscriptions.push(vscode.notebook.onDidCloseNotebookDocument(notebookDocument => clientMapper.closeClient(notebookDocument.uri)));
    context.subscriptions.push(vscode.workspace.onDidRenameFiles(e => handleFileRenames(e, clientMapper)));

    // language registration
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(async e => await updateNotebookCellLanguageInMetadata(e)));
    context.subscriptions.push(registerLanguageProviders(clientMapper, languageServiceDelay));
}

export function deactivate() {
}

interface DotnetPackExtensionExports {
    getDotnetPath(version?: string): Promise<string | undefined>;
}

async function waitForSdkInstall(requiredSdkVersion: string): Promise<void> {
    const sdkExtension = vscode.extensions.getExtension<DotnetPackExtensionExports | undefined>("ms-dotnettools.vscode-dotnet-pack");
    if (sdkExtension) {
        const sdkExports = sdkExtension.isActive
            ? sdkExtension.exports
            : await sdkExtension.activate();
        if (sdkExports) {
            const dotnetPath = await sdkExports.getDotnetPath(requiredSdkVersion);
            if (dotnetPath) {
                DotNetPathManager.setDotNetPath(dotnetPath);
            }
        }
    }
}

// keep the cell's language in metadata in sync with what VS Code thinks it is
async function updateNotebookCellLanguageInMetadata(candidateNotebookCellDocument: vscode.TextDocument) {
    const notebook = candidateNotebookCellDocument.notebook;
    if (notebook && isDotnetInteractiveLanguage(candidateNotebookCellDocument.languageId)) {
        const cell = versionSpecificFunctions.getCells(notebook).find(c => c.document === candidateNotebookCellDocument);
        if (cell) {
            const newMetadata = cell.metadata.with({
                custom: {
                    metadata: {
                        dotnet_interactive: {
                            language: getSimpleLanguage(candidateNotebookCellDocument.languageId)
                        }
                    }
                }
            });
            const edit = new vscode.WorkspaceEdit();
            edit.replaceNotebookCellMetadata(notebook.uri, cell.index, newMetadata);
            await vscode.workspace.applyEdit(edit);
        }
    }
}

function handleFileRenames(e: vscode.FileRenameEvent, clientMapper: ClientMapper) {
    for (const fileRename of e.files) {
        clientMapper.reassociateClient(fileRename.oldUri, fileRename.newUri);
    }
}

async function getInteractiveLaunchOptions(): Promise<InteractiveLaunchOptions | undefined> {
    // use dotnet-interactive or install
    const installArgs: InstallInteractiveArgs = {
        dotnetPath: DotNetPathManager.getDotNetPath(),
    };
    const launchOptions = await vscode.commands.executeCommand<InteractiveLaunchOptions>('dotnet-interactive.acquire', installArgs);
    return launchOptions;
}

async function checkForDotNetSdk(minVersion: string): Promise<boolean> {
    const result = await executeSafe(DotNetPathManager.getDotNetPath(), ['--version']);
    const checkResult = isDotNetUpToDate(minVersion, result);
    return checkResult;
}
