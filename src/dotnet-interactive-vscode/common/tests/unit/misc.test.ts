// Copyright (c) .NET Foundation and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

import { expect } from 'chai';
import { NotebookCellDisplayOutput, NotebookCellErrorOutput, NotebookCellTextOutput } from '../../interfaces/contracts';
import { isDisplayOutput, isErrorOutput, isTextOutput, reshapeOutputValueForVsCode } from '../../interfaces/utilities';
import { isIpynbFile, requiredKernelspecData, validateNotebookShape } from '../../ipynbUtilities';
import { debounce, executeSafe, isDotnetKernel, isDotNetKernelPreferred, isDotNetUpToDate, parse, processArguments, stringify } from '../../utilities';

import * as vscodeLike from '../../interfaces/vscode-like';

describe('Miscellaneous tests', () => {
    describe('preferred kernel selection', () => {
        it(`.dib file extension is always preferred`, () => {
            const filename = 'notebook.dib';
            const fileMetadata = {};
            expect(isDotNetKernelPreferred(filename, fileMetadata)).is.true;
        });

        it(`.dotnet-interactive file extension is always preferred`, () => {
            const filename = 'notebook.dotnet-interactive';
            const fileMetadata = {};
            expect(isDotNetKernelPreferred(filename, fileMetadata)).is.true;
        });

        it(`.ipynb file extension is preferred if metadata kernelspec matches`, () => {
            const filename = 'notebook.ipynb';
            const fileMetadata = {
                custom: {
                    metadata: {
                        kernelspec: requiredKernelspecData
                    }
                }
            };
            expect(isDotNetKernelPreferred(filename, fileMetadata)).is.true;
        });

        it(`.ipynb file extension is preferred for F# kernelspec`, () => {
            const filename = 'notebook.ipynb';
            const fileMetadata = {
                custom: {
                    metadata: {
                        kernelspec: {
                            display_name: '.NET (F#)',
                            language: 'F#',
                            name: '.net-fsharp',
                        }
                    }
                }
            };
            expect(isDotNetKernelPreferred(filename, fileMetadata)).is.true;
        });

        it(`.ipynb file extension is preferred improperly-cased kernelspec`, () => {
            const filename = 'notebook.ipynb';
            const fileMetadata = {
                custom: {
                    metadata: {
                        kernelspec: {
                            display_name: '.NET (C#)',
                            language: 'C#',
                            name: '.NET-CSHARP',
                        }
                    }
                }
            };
            expect(isDotNetKernelPreferred(filename, fileMetadata)).is.true;
        });

        it(`.ipynb file extension is preferred for alternate F# kernelspec`, () => {
            const filename = 'notebook.ipynb';
            const fileMetadata = {
                custom: {
                    metadata: {
                        kernelspec: {
                            display_name: '.NET (F#) (dev)',
                            language: 'F#',
                            name: '.net-fsharp-dev',
                        }
                    }
                }
            };
            expect(isDotNetKernelPreferred(filename, fileMetadata)).is.true;
        });

        it(`.ipynb file extension is preferred for PowerShell kernelspec`, () => {
            const filename = 'notebook.ipynb';
            const fileMetadata = {
                custom: {
                    metadata: {
                        kernelspec: {
                            display_name: '.NET (PowerShell)',
                            language: 'pwsh',
                            name: '.net-powershell',
                        }
                    }
                }
            };
            expect(isDotNetKernelPreferred(filename, fileMetadata)).is.true;
        });

        it(`.ipynb file extension is not preferred if metadata kernelspec doesn't match`, () => {
            const filename = 'notebook.ipynb';
            const fileMetadata = {
                custom: {
                    metadata: {
                        kernelspec: {
                            display_name: 'python',
                            name: 'python',
                            language: 'python',
                        }
                    }
                }
            };
            expect(isDotNetKernelPreferred(filename, fileMetadata)).is.false;
        });

        it(`.ipynb file extension is not preferred if metadata kernelspec is missing`, () => {
            const filename = 'notebook.ipynb';
            const fileMetadata = {};
            expect(isDotNetKernelPreferred(filename, fileMetadata)).is.false;
        });

        it(`.ipynb file extension is preferred if metadata contains an acceptable language_info value`, () => {
            const filename = 'notebook.ipynb';
            const fileMetadata = {
                custom: {
                    metadata: {
                        language_info: {
                            name: 'dotnet-interactive.fsharp'
                        }
                    }
                }
            };
            expect(isDotNetKernelPreferred(filename, fileMetadata)).is.true;
        });

        it(`.ipynb file extension is not preferred if metadata contains an unacceptable language_info value`, () => {
            const filename = 'notebook.ipynb';
            const fileMetadata = {
                custom: {
                    metadata: {
                        language_info: {
                            name: 'python'
                        }
                    }
                }
            };
            expect(isDotNetKernelPreferred(filename, fileMetadata)).is.false;
        });

        it(`unsupported file extension is not preferred even if metadata matches`, () => {
            const filename = 'notebook.not-a-notebook-we-know-about';
            const fileMetadata = {
                custom: {
                    metadata: {
                        kernelspec: requiredKernelspecData
                    }
                }
            };
            expect(isDotNetKernelPreferred(filename, fileMetadata)).is.false;
        });
    });

    it(`verify command and argument replacement is as expected`, () => {
        let template = {
            args: [
                '{dotnet_path}',
                'tool',
                'run',
                'dotnet-interactive',
                '--',
                'stdio',
                '--working-dir',
                '{working_dir}'
            ],
            workingDirectory: '{global_storage_path}'
        };
        let actual = processArguments(template, 'replacement-working-dir/notebook-file.dib', 'unused-working-dir', 'replacement-dotnet-path', 'replacement-global-storage-path');
        expect(actual).to.deep.equal({
            command: 'replacement-dotnet-path',
            args: [
                'tool',
                'run',
                'dotnet-interactive',
                '--',
                'stdio',
                '--working-dir',
                'replacement-working-dir'
            ],
            workingDirectory: 'replacement-global-storage-path'
        });
    });

    it(`uses the fallback working directory when it can't be reasonably determined`, () => {
        const template = {
            args: [
                '{dotnet_path}',
                '--working-dir',
                '{working_dir}'
            ],
            workingDirectory: '{global_storage_path}'
        };
        let actual = processArguments(template, 'notebook-file-with-no-dir.dib', 'fallback-working-dir', 'dotnet-path', 'global-storage-path');
        expect(actual).to.deep.equal({
            command: 'dotnet-path',
            args: [
                '--working-dir',
                'fallback-working-dir'
            ],
            workingDirectory: 'global-storage-path'
        });
    });

    it('debounce test', async () => {
        let callbackHit = false;
        let debounceDelay = 500;

        // repeatedly call `debounce` with small delays
        for (let i = 0; i < 10; i++) {
            debounce('key', debounceDelay, () => {
                if (callbackHit) {
                    throw new Error('Deboune callback was called more than once; this should never happen.');
                }

                callbackHit = true;
            });

            await new Promise(resolve => setTimeout(resolve, 100));
        }

        // wait for the debounced callback to actually have a chance
        await new Promise(resolve => setTimeout(resolve, debounceDelay * 1.1));
        expect(callbackHit).to.be.true;
    }).timeout(5000);

    it('cell error output shape can be detected', () => {
        // strongly typed to catch interface changes
        const error: NotebookCellErrorOutput = {
            errorName: 'ename',
            errorValue: 'evalue',
            stackTrace: [
                'stack trace line 1',
                'stack trace line 2'
            ]
        };
        expect(isErrorOutput(error)).to.be.true;
    });

    it('cell display output shape can be detected', () => {
        // strongly typed to catch interface changes
        const display: NotebookCellDisplayOutput = {
            data: {
                'text/html': 'html',
                'text/plain': 'text'
            }
        };
        expect(isDisplayOutput(display)).to.be.true;
    });

    it('cell text output shape can be detected', () => {
        // strongly typed to catch interface changes
        const text: NotebookCellTextOutput = {
            text: 'some text'
        };
        expect(isTextOutput(text)).to.be.true;
    });

    it('parse function can handle base64-encoded Uint8Array', () => {
        const numbers = [1, 2, 3];
        const base64 = Buffer.from(numbers).toString('base64');
        const value = parse(`{"rawData":"${base64}"}`);
        expect(value).to.deep.equal({
            rawData: Uint8Array.from(numbers)
        });
    });

    it('stringify function can handle Uint8Array', () => {
        const numbers = [1, 2, 3];
        const text = stringify({
            rawData: new Uint8Array(numbers)
        });
        const expectedBase64 = Buffer.from(numbers).toString('base64');
        expect(text).to.equal(`{"rawData":"${expectedBase64}"}`);
    });

    it('stringify function can handle Buffer', () => {
        const numbers = [1, 2, 3];
        const text = stringify({
            rawData: Buffer.from(numbers)
        });
        const expectedBase64 = Buffer.from(numbers).toString('base64');
        expect(text).to.equal(`{"rawData":"${expectedBase64}"}`);
    });

    describe('vs code output value reshaping', () => {
        it('error string is reshaped', () => {
            const reshaped = reshapeOutputValueForVsCode(vscodeLike.ErrorOutputMimeType, 'some error message');
            expect(reshaped).to.deep.equal({
                ename: 'Error',
                evalue: 'some error message',
                traceback: [],
            });
        });

        it(`properly shaped output isn't reshaped`, () => {
            const reshaped = reshapeOutputValueForVsCode(vscodeLike.ErrorOutputMimeType, { ename: 'Error2', evalue: 'some error message', traceback: [] });
            expect(reshaped).to.deep.equal({
                ename: 'Error2',
                evalue: 'some error message',
                traceback: [],
            });
        });

        it('non-string error message is not reshaped', () => {
            const reshaped = reshapeOutputValueForVsCode(vscodeLike.ErrorOutputMimeType, { some_deep_value: 'some error message' });
            expect(reshaped).to.deep.equal({
                some_deep_value: 'some error message',
            });
        });

        it(`non-error mime type doesn't reshape output`, () => {
            const reshaped = reshapeOutputValueForVsCode('text/plain', 'some error message');
            expect(reshaped).to.equal('some error message');
        });
    });

    it('executing a non-existent process still returns', async () => {
        const result = await executeSafe('this-is-a-command-that-will-fail', []);
        expect(result).to.deep.equal({
            code: -1,
            output: '',
            error: 'Error: spawn this-is-a-command-that-will-fail ENOENT',
        });
    });

    describe('dotnet version sufficiency tests', () => {
        it('supported version is allowed', () => {
            const isSupported = isDotNetUpToDate('5.0', { code: 0, output: '5.0.101' });
            expect(isSupported).to.be.true;
        });

        it(`version number acquisition passes, but version isn't sufficient`, () => {
            const isSupported = isDotNetUpToDate('5.0', { code: 0, output: '3.1.403' });
            expect(isSupported).to.be.false;
        });

        it(`version number looks good, but return code wasn't`, () => {
            const isSupported = isDotNetUpToDate('5.0', { code: 1, output: '5.0.101' });
            expect(isSupported).to.be.false;
        });

        it('version number check crashed', () => {
            const isSupported = isDotNetUpToDate('5.0', { code: -1, output: '' });
            expect(isSupported).to.be.false;
        });
    });

    describe('.ipynb helpers', () => {
        it('file extension of .ipynb matches', () => {
            expect(isIpynbFile('notebook.ipynb')).to.be.true;
            expect(isIpynbFile('NOTEBOOK.IPYNB')).to.be.true;
        });

        it(`file extension of .dib doesn't match`, () => {
            expect(isIpynbFile('notebook.dib')).to.be.false;
            expect(isIpynbFile('notebook.dotnet-interactive')).to.be.false;
        });

        it(`.net notebook with languages doesn't trigger validation failure`, done => {
            const notebookData = {
                cells: [
                    {
                        cell_type: "code",
                        metadata: {
                            dotnet_interactive: {
                                language: 'csharp'
                            }
                        }
                    }
                ],
                metadata: {
                    kernelspec: {
                        name: '.net-csharp'
                    }
                }
            };
            validateNotebookShape(notebookData, (_isError, message) => {
                done(`Unexpected validation failure: ${message}`);
            });
            done();
        });

        it(`.net notebook with markdown cells without languages doesn't trigger validation failure`, done => {
            const notebookData = {
                cells: [
                    {
                        cell_type: "markdown"
                    }
                ],
                metadata: {
                    kernelspec: {
                        name: '.net-csharp'
                    }
                }
            };
            validateNotebookShape(notebookData, (_isError, message) => {
                done(`Unexpected validation failure: ${message}`);
            });
            done();
        });

        it(`.net notebook with bad language triggers validation warning`, done => {
            const notebookData = {
                cells: [
                    {
                        cell_type: "code",
                        metadata: {
                            dotnet_interactive: {
                                language: 42
                            }
                        }
                    }
                ],
                metadata: {
                    kernelspec: {
                        name: '.net-csharp'
                    }
                }
            };
            validateNotebookShape(notebookData, (isError, _message) => {
                if (isError) {
                    done('failure should have been a warning');
                } else {
                    done();
                }
            });
        });

        it(`.net notebook without code cell metadata triggers validation warning`, done => {
            const notebookData = {
                cells: [
                    {
                        cell_type: "code",
                        metadata: {}
                    }
                ],
                metadata: {
                    kernelspec: {
                        name: '.net-csharp'
                    }
                }
            };
            validateNotebookShape(notebookData, (isError, _message) => {
                if (isError) {
                    done('failure should have been a warning');
                } else {
                    done();
                }
            });
        });

        it(`non-.net notebook triggers validation error`, done => {
            const notebookData = {
                cells: [],
                metadata: {
                    kernelspec: {
                        name: 'python'
                    }
                }
            };
            validateNotebookShape(notebookData, (isError, _message) => {
                if (!isError) {
                    done('failure should have been an error');
                } else {
                    done();
                }
            });
        });

        it('.net kernelspec can be detected', () => {
            expect(isDotnetKernel('.net-csharp')).to.be.true;
            expect(isDotnetKernel('.net-fsharp')).to.be.true;
        });

        it(`non-.net kernelspec isn't detected`, () => {
            expect(isDotnetKernel('python')).to.be.false;
            expect(isDotnetKernel(42)).to.be.false;
            expect(isDotnetKernel(undefined)).to.be.false;
        });
    });
});
