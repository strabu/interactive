﻿// Copyright (c) .NET Foundation and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

using System;
using System.Reactive.Disposables;
using System.Reactive.Linq;
using System.Reactive.Subjects;
using System.Threading.Tasks;

using Microsoft.DotNet.Interactive.Commands;
using Microsoft.DotNet.Interactive.Connection;
using Microsoft.DotNet.Interactive.Events;


namespace Microsoft.DotNet.Interactive.Server
{
    public class KernelClient : KernelClientBase, IDisposable
    {
        private readonly IInputTextStream _input;
        private readonly IOutputTextStream _output;

        private readonly CompositeDisposable _disposables;
        private readonly ISubject<KernelEvent> _kernelEvents = new Subject<KernelEvent>();

        public KernelClient(
            IInputTextStream input,
            IOutputTextStream output)
        {
            _input = input ?? throw new ArgumentNullException(nameof(input));
            _output = output ?? throw new ArgumentNullException(nameof(output));

            _disposables = new CompositeDisposable
            {
                _input.Subscribe(DeserializeAndSendEvent)
            };
        }
        public IObservable<string> Input => _input;
        public IObservable<string> Output => _output.OutputObservable;
        public bool IsStarted => _input.IsStarted;

        public override IObservable<KernelEvent> KernelEvents => _kernelEvents;

        public async override Task SendAsync(KernelCommand command, string token = null)
        {
            if (!string.IsNullOrWhiteSpace(token))
            {
                command.SetToken(token);
            }

            var completionSource = new TaskCompletionSource<bool>();
            token = command.GetToken();
            var sub = _kernelEvents
                .Where(e => e.Command.GetToken() == token)
                .Subscribe(kernelEvent =>
                {
                    switch (kernelEvent)
                    {
                        case CommandFailed _:
                        case CommandSucceeded _:
                            completionSource.SetResult(true);
                            break;

                    }
                });

            var envelope = KernelCommandEnvelope.Create(command);

            var serialized = KernelCommandEnvelope.Serialize(envelope);

            _output.Write(serialized);

            await completionSource.Task;

            sub.Dispose();
        }

        private void DeserializeAndSendEvent(string line)
        {
            IKernelEventEnvelope kernelEventEnvelope = null;
            try
            {
                kernelEventEnvelope = KernelEventEnvelope.Deserialize(line);
               
            }
            catch (Exception ex)
            {
                var diagnosticEvent = new DiagnosticLogEntryProduced(
                    $"Error while parsing command: {ex.Message}\n{line}", KernelCommand.None);

                _kernelEvents.OnNext(diagnosticEvent);
            }

            if (kernelEventEnvelope is not null)
            {
                _kernelEvents.OnNext(kernelEventEnvelope.Event);
            }
        }

        public void Start()
        {
            if (_input is InputTextStream pollingInputTextStream)
            {
                pollingInputTextStream.Start();
            }
        }

        public void Dispose()
        {
            _disposables.Dispose();
        }
    }
}